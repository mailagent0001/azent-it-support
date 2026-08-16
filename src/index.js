/**
 * A-Zent IT保守サブスク - Cloudflare Workers メインエントリ v2.6
 *
 * v2.6変更点:
 *   CL側の一次対応を拡充。
 *   ・同種機器が複数登録 → Quick Replyで機種選択させてから回答
 *   ・該当機器が未登録   → メーカー・型番をその場で聞いて自己登録し、
 *                          登録した機器で改めて照合・回答
 *   会話の一時状態は conversation_state テーブルに保存する。
 */

import { MatchEngine }    from './matchEngine.js';
import { ApprovalEngine } from './approvalEngine.js';
import { LineClient }     from './lineClient.js';
import { Dispatcher }     from './dispatcher.js';
import { generateAndSaveTree } from './treeGenerator.js';

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
    if (request.method === 'GET' && url.pathname.startsWith('/devices/')) {
      return handleDevicesPage(request, env, url.pathname.replace('/devices/', ''));
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

async function handleDevicesPage(request, env, dispatchId) {
  const log = await env.DB.prepare(
    'SELECT company_id FROM dispatch_log WHERE dispatch_id = ?'
  ).bind(dispatchId).first();

  if (!log) {
    return new Response('案件が見つかりません', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const company = await env.DB.prepare(
    'SELECT * FROM companies WHERE company_id = ?'
  ).bind(log.company_id).first();

  const devices = await env.DB.prepare(
    'SELECT * FROM devices WHERE company_id = ?'
  ).bind(log.company_id).all();

  const rows = (devices.results || []).map(d => `
    <tr>
      <td>${escapeHtml(d.device_type || '')}</td>
      <td>${escapeHtml(d.maker || '')}</td>
      <td>${escapeHtml(d.model || '')}</td>
      <td>${escapeHtml(d.location || '')}</td>
      <td>${escapeHtml(d.notes || '')}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>機器一覧 - ${escapeHtml(company?.company_name || '')}</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 16px; color: #222; }
  h1 { font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { border: 1px solid #ddd; padding: 8px; font-size: 14px; text-align: left; }
  th { background: #f5f5f5; }
</style>
</head>
<body>
  <h1>${escapeHtml(company?.company_name || '不明')} の登録機器一覧</h1>
  <p>住所: ${escapeHtml(company?.address || '不明')}</p>
  <table>
    <tr><th>種別</th><th>メーカー</th><th>型番</th><th>設置場所</th><th>備考</th></tr>
    ${rows || '<tr><td colspan="5">登録機器がありません</td></tr>'}
  </table>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

// ============================================================
// 会話状態(機種選択待ち・機種登録待ち)の保存/取得/削除
// ============================================================
async function saveState(db, key, companyId, stateType, payload) {
  await db.prepare(`
    INSERT INTO conversation_state (key, company_id, state_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET state_type = excluded.state_type, payload = excluded.payload, created_at = excluded.created_at
  `).bind(key, companyId, stateType, JSON.stringify(payload), new Date().toISOString()).run();
}

async function getState(db, key) {
  const row = await db.prepare('SELECT * FROM conversation_state WHERE key = ?').bind(key).first();
  if (!row) return null;
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
}

async function clearState(db, key) {
  await db.prepare('DELETE FROM conversation_state WHERE key = ?').bind(key).run();
}

function stateKeyFor(event) {
  const sourceType = event.source?.type;
  if (sourceType === 'group' || sourceType === 'room') {
    return `g:${event.source.groupId || event.source.roomId}`;
  }
  return `u:${event.source?.userId}`;
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
      const company = await resolveCompany(event, env.DB);
      if (!company) {
        if (event.type === 'message' && event.message?.type === 'text') {
          await line.reply(event.replyToken, '登録されていないLINEアカウント/グループです。担当者にご確認ください。');
        }
        continue;
      }

      const key = stateKeyFor(event);

      // 機種選択の postback
      if (event.type === 'postback') {
        const params = new URLSearchParams(event.postback.data);
        if (params.get('action') === 'select_device') {
          const deviceId = params.get('device_id');
          const state = await getState(env.DB, key);
          const symptomText = state?.payload?.symptomText || '';
          await clearState(env.DB, key);

          const result = await matcher.matchForDevice(deviceId, symptomText);
          await handleMatchResult(env, line, event.replyToken, company, symptomText, result);
        }
        continue;
      }

      if (event.type !== 'message' || event.message?.type !== 'text') continue;
      const symptomText = event.message.text;

      // 機種登録待ちの状態か確認(「メーカー 型番」の形式で返信されることを想定)
      const state = await getState(env.DB, key);
      if (state?.state_type === 'awaiting_device_registration') {
        const parts = symptomText.trim().split(/\s+/);
        const maker = parts[0] || '';
        const model = parts.slice(1).join(' ') || '';
        const deviceType = state.payload.deviceType;
        const origSymptom = state.payload.symptomText;

        const newDeviceId = `D${Date.now()}`;
        await env.DB.prepare(`
          INSERT INTO devices (device_id, company_id, device_type, maker, model, location, install_date, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(newDeviceId, company.company_id, deviceType, maker, model, '未設定', new Date().toISOString().slice(0, 10), 'CL自己登録').run();

        await clearState(env.DB, key);

        // その機種専用の症状診断ツリーを自動生成(失敗しても共通版で動作継続するため待たずに投げっぱなしにはしない)
        try {
          await generateAndSaveTree(env, deviceType, maker, model);
        } catch (e) {
          console.error('generateAndSaveTree error:', e);
        }

        const result = await matcher.matchForDevice(newDeviceId, origSymptom);
        await line.reply(
          event.replyToken,
          `機器を登録しました(${maker} ${model})。\n\n` + buildCustomerReply(result)
        );
        if (result.status === 'escalate_immediately' || result.status === 'no_match') {
          const dispatcher = new Dispatcher(env);
          await dispatcher.dispatch(company.company_id, origSymptom, result.status, { maker, model });
        }
        continue;
      }

      if (symptomText.includes('解決しない') || symptomText.includes('直らない')) {
        const dispatcher = new Dispatcher(env);
        const dispatchId = await dispatcher.dispatch(company.company_id, symptomText, 'manual_escalation');
        await line.reply(event.replyToken, `担当者を手配します。少々お待ちください。\n(案件ID: ${dispatchId})`);
        continue;
      }

      const result = await matcher.match(company.company_id, symptomText);

      if (result.status === 'needs_device_selection') {
        await saveState(env.DB, key, company.company_id, 'awaiting_device_selection', { symptomText });
        await line.replyWithQuickReply(
          event.replyToken,
          `該当する${result.deviceType}が複数登録されています。どちらですか?`,
          result.options.map(o => ({ label: o.label, data: `action=select_device&device_id=${o.device_id}` }))
        );
        continue;
      }

      if (result.status === 'needs_device_registration') {
        await saveState(env.DB, key, company.company_id, 'awaiting_device_registration', { symptomText, deviceType: result.deviceType });
        await line.reply(
          event.replyToken,
          `${result.deviceType}のようですが、登録されていない機器のようです。\nメーカーと型番を教えてください。\n(例: Canon iR-ADV C3830)`
        );
        continue;
      }

      await handleMatchResult(env, line, event.replyToken, company, symptomText, result);
    }

    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('handleCustomerWebhook error:', err);
    return Response.json({ status: 'error', message: String(err) }, { status: 500 });
  }
}

async function handleMatchResult(env, line, replyToken, company, symptomText, result) {
  const replyText = buildCustomerReply(result);
  await line.reply(replyToken, replyText);

  if (result.status === 'escalate_immediately' || result.status === 'no_match') {
    const dispatcher = new Dispatcher(env);
    await dispatcher.dispatch(company.company_id, symptomText, result.status, {
      maker: result.deviceMaker, model: result.deviceModel
    });
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

        if (action === 'decline') {
          const ok = await dispatcher.declineAndForward(vendor.vendor_id, dispatchId);
          await line.reply(
            event.replyToken,
            ok ? '見送りを受け付けました。次の業者へ案内します。' : 'この案件は既に処理済み、または見つかりませんでした。'
          );
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

      if (text.includes('キャンセル')) {
        const dispatcher = new Dispatcher(env);
        const result = await dispatcher.cancelAndReassign(vendor.vendor_id);
        await line.reply(
          event.replyToken,
          result
            ? `キャンセルを受け付けました。次の業者へ再手配します。\n(案件ID: ${result.dispatch_id})`
            : '受注中の案件が見つかりませんでした。'
        );
        continue;
      }

      if (text.includes('報告')) {
        await line.reply(event.replyToken, '修繕報告ありがとうございます。内容を確認後、ご連絡します。');
        continue;
      }

      await line.reply(event.replyToken, '案件通知のボタンから「受注する」または「見送る」を選択するか、受注後のキャンセルは「キャンセル」、対応後は「報告」で返信してください。');
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
