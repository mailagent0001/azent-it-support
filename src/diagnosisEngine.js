/**
 * 症状診断ツリー(diagnosis_trees)を読み込み、LINEのボタンで
 * 分岐を進めるエンジン。
 *
 * 会話の状態は conversation_state テーブルに保存する
 * (state_type = 'tree_walk', payload = { tree_id, node_id, device_id, symptom_text }).
 */

import { Dispatcher } from './dispatcher.js';

/** 機器に対応するツリーを探す。型番専用があればそれ、なければ共通版にフォールバック */
async function loadTreeForDevice(db, device) {
  let row = await db.prepare(
    'SELECT * FROM diagnosis_trees WHERE device_type = ? AND maker = ? AND model_pattern = ?'
  ).bind(device.device_type, device.maker || '共通', device.model || '共通').first();

  if (!row) {
    row = await db.prepare(
      'SELECT * FROM diagnosis_trees WHERE device_type = ? AND maker = ? AND model_pattern = ?'
    ).bind(device.device_type, '共通', '共通').first();
  }

  if (!row) return null;
  try {
    return JSON.parse(row.tree_json);
  } catch (e) {
    console.error('loadTreeForDevice: JSONパース失敗', row.tree_id, e.message);
    return null;
  }
}

async function loadTreeById(db, treeId) {
  const row = await db.prepare('SELECT tree_json FROM diagnosis_trees WHERE tree_id = ?').bind(treeId).first();
  if (!row) return null;
  try {
    return JSON.parse(row.tree_json);
  } catch (e) {
    console.error('loadTreeById: JSONパース失敗', treeId, e.message);
    return null;
  }
}

async function saveTreeState(db, key, companyId, treeId, nodeId, deviceId, symptomText) {
  await db.prepare(`
    INSERT INTO conversation_state (key, company_id, state_type, payload, created_at)
    VALUES (?, ?, 'tree_walk', ?, ?)
    ON CONFLICT(key) DO UPDATE SET state_type = 'tree_walk', payload = excluded.payload, created_at = excluded.created_at
  `).bind(key, companyId, JSON.stringify({ tree_id: treeId, node_id: nodeId, device_id: deviceId, symptom_text: symptomText }), new Date().toISOString()).run();
}

async function updateTreeStateNode(db, key, nodeId) {
  const row = await db.prepare('SELECT * FROM conversation_state WHERE key = ?').bind(key).first();
  if (!row) return;
  const payload = JSON.parse(row.payload);
  payload.node_id = nodeId;
  await db.prepare('UPDATE conversation_state SET payload = ? WHERE key = ?').bind(JSON.stringify(payload), key).run();
}

async function getTreeState(db, key) {
  const row = await db.prepare('SELECT * FROM conversation_state WHERE key = ? AND state_type = ?').bind(key, 'tree_walk').first();
  if (!row) return null;
  return { ...JSON.parse(row.payload), company_id: row.company_id };
}

async function clearTreeState(db, key) {
  await db.prepare('DELETE FROM conversation_state WHERE key = ?').bind(key).run();
}

/** 機器選択直後に呼ぶ。ツリーが見つからなければ false を返す(呼び出し側で旧ロジックにフォールバック) */
export async function startDiagnosis(env, line, replyToken, key, company, device, symptomText) {
  const tree = await loadTreeForDevice(env.DB, device);
  if (!tree) return false;

  await saveTreeState(env.DB, key, company.company_id, tree.tree_id, 'root', device.device_id, symptomText);
  await renderNode(line, replyToken, tree, 'root');
  return true;
}

/** 「解決した/してない」等のボタン押下時に呼ぶ */
export async function continueDiagnosis(env, line, replyToken, key, targetNodeId) {
  const state = await getTreeState(env.DB, key);
  if (!state) {
    await line.reply(replyToken, '診断の状態が見つかりませんでした。お手数ですが症状をもう一度お送りください。');
    return;
  }

  const tree = await loadTreeById(env.DB, state.tree_id);
  if (!tree || !tree.nodes[targetNodeId]) {
    await line.reply(replyToken, '診断データの読み込みに失敗しました。お手数ですが症状をもう一度お送りください。');
    await clearTreeState(env.DB, key);
    return;
  }

  const node = tree.nodes[targetNodeId];

  if (node.type === 'resolved') {
    await line.reply(replyToken, 'ご利用ありがとうございました。解決して良かったです。またお困りの際はご連絡ください。');
    await clearTreeState(env.DB, key);
    return;
  }

  if (node.type === 'cancelled') {
    await line.reply(replyToken, '承知しました。またお困りの際はいつでもご連絡ください。');
    await clearTreeState(env.DB, key);
    return;
  }

  if (node.type === 'escalate') {
    const dispatcher = new Dispatcher(env);
    await dispatcher.dispatch(
      state.company_id,
      state.symptom_text || tree.device_type,
      'escalate_immediately',
      { maker: tree.maker, model: tree.model_pattern }
    );
    await line.reply(replyToken, `担当者を手配します。少々お待ちください。\n(理由: ${node.reason || ''})`);
    await clearTreeState(env.DB, key);
    return;
  }

  await updateTreeStateNode(env.DB, key, targetNodeId);
  await renderNode(line, replyToken, tree, targetNodeId);
}

async function renderNode(line, replyToken, tree, nodeId) {
  const node = tree.nodes[nodeId];

  if (node.type === 'choice') {
    await line.replyWithQuickReply(
      replyToken,
      node.prompt,
      node.options.map(o => ({ label: o.label, data: `action=tree_next&node=${encodeURIComponent(o.next)}` }))
    );
    return;
  }

  if (node.type === 'fix') {
    await line.replyWithQuickReply(
      replyToken,
      node.instruction,
      [
        { label: '解決した', data: `action=tree_next&node=${encodeURIComponent(node.next_ok)}` },
        { label: '解決しない', data: `action=tree_next&node=${encodeURIComponent(node.next_ng)}` }
      ]
    );
    return;
  }

  if (node.type === 'danger_confirm') {
    await line.replyWithQuickReply(
      replyToken,
      node.warning,
      [
        { label: '業者を呼ぶ', data: `action=tree_next&node=${encodeURIComponent(node.next_call)}` },
        { label: '今は呼ばない', data: `action=tree_next&node=${encodeURIComponent(node.next_wait)}` }
      ]
    );
    return;
  }

  console.error('renderNode: 未対応のノードtype', node.type, nodeId);
  await line.reply(replyToken, '診断データにエラーがあります。担当者にご確認ください。');
}
