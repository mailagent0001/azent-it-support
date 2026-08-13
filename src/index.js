/**
 * A-Zent IT保守サブスク - Cloudflare Workers メインエントリ v2.2
 *
 * v2.2変更点:
 *   業者の受注をボタン(postback)化。受注→到着予定時間(Quick Reply)選択の
 *   2段階フローに変更。到着予定時間はCL側への通知にも反映。
 */

import { MatchEngine }    from './matchEngine.js';
import { ApprovalEngine } from './approvalEngine.js';
import { LineClient }     from './lineClient.js';
import { Dispatcher }     from './dispatcher.js';

const ETA_OPTIONS = [
  { label: '15分以内', minutes: 15 },
  { label: '30分以内', minutes: 30 },
  { label: '1時間以内', minutes: 60 },
  { label: '1時間半以内', minutes: 90 },
  { label: '2時間以内', minutes: 120 }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
    if (request.method === 'POST' && url.pathname === '/webhook/line') {
      return handleCustomerWebhook(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook/vendor') {
      return handleVendorWebhook(request, env);
    }
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env) {
    const dispatcher = new Dispatcher(env);
    await dispatcher.checkTimeouts();
  }
};

async function resolveCompany(event, db) {
  const sourceType = event.source?.type;
  if (sourceType === 'group' || sourceType === 'room') {
    const groupId = event.source.groupId || event.source.roomId;
    if (!groupId) return null;
    return await db.prepare('SELECT * FROM companies WHERE group_line_id = ?').bind(groupId).first();
  }
  const userId = event.source?.userId;
  if (!userId) return null;
  return await db.prepare('SELECT * FROM companies WHERE approver_line_id = ?').bind(userId).first();
}

async function handleCustomerWebhook(request, env) {
  try {
    const body = await request.text();

    if (env.LINE_CHANNEL_SECRET) {
      const isValid = await verifyLineSignature(
        body, request.headers.get('x-line-signature') || '', env.LINE_CHANNEL_SECRET
      );
      if (!isValid) return new Response('Unauthorized', { status: 401 });
    }

    const payload = JSON.parse(body);
    const events  = payload.events || [];
    const line    = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
    const matcher = new MatchEngine(env.DB);

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const symptomText = event.message.text;
      const company     = await resolveCompany(event, env.DB);

      if (!company) {
        await line.reply(event.replyToken, '登録されていないLINEアカウント/グループです。担当者にご確認ください。');
        continue;
      }

      if (symptomText.includes('解決しない') || symptomText.includes('直らない')) {
        const dispatcher = new Dispatcher(env);
        const dispatchId = await dispatcher.dispatch(company.company_id, symptomText, 'manual_escalation');
        await line.reply(event.replyToken, `担当者を手配します。少々お待ちください。\n(案件ID: ${dispatchId})`);
        continue;
      }

      const result    = await matcher.match(company.company_id, symptomText);
      const replyText = buildCustomerReply(result);
      await line.reply(event.replyToken, replyText);

      if (result.status === 'escalate_immediately' || result.status === 'no_match') {
        const dispatcher = new Dispatcher(env);
        await dispatcher.dispatch(company.company_id, symptomText, result.status);
      }
    }

    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('handleCustomerWebhook error:', err);
    return Response.json({ status: 'error', message: String(err) }, { status: 500 });
  }
}

async function handleVendorWebhook(request, env) {
  try {
    const body    = await request.text();
    const payload = JSON.parse(body);
    const events  = payload.events || [];
    const line    = new LineClient(env.VENDOR_LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_ACCESS_TOKEN);

    for (const event of events) {
      const vendorLineId = event.source?.userId;
      if (!vendorLineId) continue;

      const vendor = await env.DB.prepare('SELECT * FROM vendors WHERE line_id = ?').bind(vendorLineId).first();

      if (!vendor) {
        if (event.replyToken) await line.reply(event.replyToken, '登録されていない業者アカウントです。');
        continue;
      }

      if (event.type === 'postback') {
        const params = new URLSearchParams(event.postback.data);
        const action = params.get('action');
        const dispatchId = params.get('dispatch_id');
        const dispatcher = new Dispatcher(env);

        if (action === 'accept') {
          const result = await dispatcher.acceptDispatch(vendor.vendor_id, dispatchId);
          if (result) {
            await line.replyWithQuickReply(
              event.replyToken,
              `受注を受けました。すみやかに現場に向かい対応をお願いします。\n到着予定時間を選択してください。`,
              ETA_OPTIONS.map(o => ({ label: o.label, data: `action=eta&dispatch_id=${dispatchId}&minutes=${o.minutes}` }))
            );
          } else {
            await line.reply(event.replyToken, 'この案件は既に受付済み、または見つかりませんでした。');
          }
          continue;
        }

        if (action === 'eta') {
          const minutes = parseInt(params.get('minutes'), 10);
          const opt = ETA_OPTIONS.find(o => o.minutes === minutes);
          const result = await dispatcher.setEtaAndNotifyCustomer(vendor.vendor_id, dispatchId, minutes, opt?.label || `${minutes}分以内`);
          if (result) {
            await line.reply(event.replyToken, `了解しました。対応をお願いします。\n(${result.company_name})`);
          } else {
            await line.reply(event.replyToken, '案件が見つかりませんでした。');
          }
          continue;
        }

        continue;
      }

      if (event.type !== 'message' || event.message?.type !== 'text') continue;
      const text = event.message.text;

      if (text.includes('報告')) {
        await line.reply(event.replyToken, '修繕報告ありがとうございます。内容を確認後、ご連絡します。');
        continue;
      }

      await line.reply(event.replyToken, '案件通知のボタンから「受注する」を押すか、「報告」で返信してください。');
    }

    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('handleVendorWebhook error:', err);
    return Response.json({ status: 'error', message: String(err) }, { status: 500 });
  }
}

function buildCustomerReply(result) {
  if (result.status === 'error') {
    return 'お問い合わせありがとうございます。登録情報の確認ができませんでした。担当者までご連絡ください。';
  }
  if (result.status === 'no_match') {
    return '症状を確認しました。該当する対処法が見つからなかったため、担当者を手配します。少々お待ちください。';
  }
  if (result.status === 'escalate_immediately') {
    return `【${result.device}】\n症状を確認しました。現地対応が必要と判断しました。提携の修理業者を手配します。少々お待ちください。`;
  }
  return `【${result.device}】\n以下をお試しください(${result.matchType})\n\n■確認: ${result.diagnosis}\n■対処: ${result.fix}\n\n解決しない場合は「解決しない」とご返信ください。`;
}

async function verifyLineSignature(body, signature, secret) {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig      = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return expected === signature;
  } catch {
    return false;
  }
}
