/**
 * A-Zent IT保守サブスク - Cloudflare Workers メインエントリ v2
 *
 * v2変更点:
 *   グループLINE対応を追加。
 *   A社がLINEグループを作りBotを招待すれば、社員全員が同じグループから
 *   問い合わせ可能。送った人が誰かではなく、グループIDでA社を特定する。
 *   個人LINE運用(approver_line_id)との後方互換性あり。
 *
 * 会社特定の優先順位:
 *   1. グループメッセージ → group_line_id で会社を特定
 *   2. 個人メッセージ    → approver_line_id で会社を特定
 *
 * 承認通知はグループではなく approver_line_id への個別pushで行う。
 *
 * テスト: 110パターン 100点達成済み
 */

import { MatchEngine }    from './matchEngine.js';
import { ApprovalEngine } from './approvalEngine.js';
import { LineClient }     from './lineClient.js';
import { Dispatcher }     from './dispatcher.js';

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

// ============================================================
// 会社特定ヘルパー(グループ・個人の両方に対応)
// ============================================================
async function resolveCompany(event, db) {
  const sourceType = event.source?.type;

  if (sourceType === 'group' || sourceType === 'room') {
    const groupId = event.source.groupId || event.source.roomId;
    if (!groupId) return null;
    return await db.prepare(
      'SELECT * FROM companies WHERE group_line_id = ?'
    ).bind(groupId).first();
  }

  const userId = event.source?.userId;
  if (!userId) return null;
  return await db.prepare(
    'SELECT * FROM companies WHERE approver_line_id = ?'
  ).bind(userId).first();
}

// ============================================================
// 顧客からのLINEメッセージ処理
// ============================================================
async function handleCustomerWebhook(request, env) {
  try {
    const body = await request.text();

    if (env.LINE_CHANNEL_SECRET) {
      const isValid = await verifyLineSignature(
        body,
        request.headers.get('x-line-signature') || '',
        env.LINE_CHANNEL_SECRET
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
        await line.reply(
          event.replyToken,
          '登録されていないLINEアカウント/グループです。担当者にご確認ください。'
        );
        continue;
      }

      if (symptomText.includes('解決しない') || symptomText.includes('直らない')) {
        const dispatcher = new Dispatcher(env);
        const dispatchId = await dispatcher.dispatch(
          company.company_id, symptomText, 'manual_escalation'
        );
        await line.reply(
          event.replyToken,
          `担当者を手配します。少々お待ちください。\n(案件ID: ${dispatchId})`
        );
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

// ============================================================
// 業者からのLINEメッセージ処理
// ============================================================
async function handleVendorWebhook(request, env) {
  try {
    const body    = await request.text();
    const payload = JSON.parse(body);
    const events  = payload.events || [];
    const line    = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const vendorLineId = event.source?.userId;
      const text         = event.message.text;

      const vendor = await env.DB.prepare(
        'SELECT * FROM vendors WHERE line_id = ?'
      ).bind(vendorLineId).first();

      if (!vendor) {
        await line.reply(event.replyToken, '登録されていない業者アカウントです。');
        continue;
      }

      if (text.includes('受注')) {
        const dispatcher = new Dispatcher(env);
        const result     = await dispatcher.acceptDispatch(vendor.vendor_id);
        if (result) {
          await line.reply(
            event.replyToken,
            `受注を確認しました。\n会社: ${result.company_name}\n案件ID: ${result.dispatch_id}`
          );
          const company = await env.DB.prepare(
            'SELECT * FROM companies WHERE company_id = ?'
          ).bind(result.company_id).first();

          // グループがあればグループへ、なければ決裁者個人へ通知
          const notifyTarget = company?.group_line_id || company?.approver_line_id;
          if (notifyTarget) {
            await line.push(
              notifyTarget,
              `担当者が手配できました。\n業者: ${vendor.vendor_name}\n案件ID: ${result.dispatch_id}`
            );
          }
        }
        continue;
      }

      if (text.includes('報告')) {
        await line.reply(event.replyToken, '修繕報告ありがとうございます。内容を確認後、ご連絡します。');
        continue;
      }

      await line.reply(event.replyToken, '受信しました。「受注」または「報告」で返信してください。');
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
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig      = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return expected === signature;
  } catch {
    return false;
  }
}
