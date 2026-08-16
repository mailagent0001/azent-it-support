/**
 * 症状診断ツリーの自動生成オーケストレーション
 *
 * 新規機器登録時に呼び出され、以下を行う:
 *   1. Gemini APIへ「エラー表示優先版」指示書+機種情報でツリー生成を依頼
 *   2. 生成結果をtreeValidatorで検証
 *   3. 検証OKならdiagnosis_treesに保存(is_verified=1)
 *   4. 検証NGなら共通版へのフォールバックのまま、管理者へLINE通知
 */

import { GeminiClient } from './geminiClient.js';
import { validateTree } from './treeValidator.js';
import { LineClient } from './lineClient.js';

const PROMPT_TEMPLATE = `あなたはIT保守サービスの診断フロー設計者です。指定された機器について、顧客(専門知識のないオフィスワーカー)がLINEのボタン操作だけで症状を絞り込み、可能なら自己解決できるようにするための症状診断ツリーを、以下のスキーマに厳密に従ったJSON形式で生成してください。

## スキーマ仕様
トップレベル:
{ "tree_id": "<device_type>_<maker>_<model>_v1", "device_type": "...", "maker": "...", "model_pattern": "...", "nodes": { ... } }

nodesはrootから始まるノードの辞書。各ノードは以下5種類のいずれか。

1. choice: { "type": "choice", "prompt": "質問文", "options": [{ "label": "選択肢(20文字以内)", "next": "次ノードID" }] }
2. fix: { "type": "fix", "instruction": "対処手順", "next_ok": "解決時の次ノードID", "next_ng": "未解決時の次ノードID" }
3. danger_confirm: { "type": "danger_confirm", "warning": "注意文(危険なら消防119番言及)", "next_call": "escalateノードID", "next_wait": "終了ノードID" }
4. escalate: { "type": "escalate", "reason": "業者手配理由" }
5. resolved / cancelled: { "type": "resolved" } / { "type": "cancelled" }

## 設計ルール(厳守)
- rootは必ずchoiceで、安全確認(煙・焦げ臭い・異常発熱・液漏れ・火花・破損の有無)を最上位に置く
- 「ある/判断できない」は直接danger_confirmへ。warningに119番言及を含める
- 安全確認の後、エラー表示の有無を確認するchoiceへ進める
- エラーコード一覧が入力にある場合のみ、実在するコードだけで専用分岐を作る(推測・捏造禁止)
- 表示メッセージがある場合はカテゴリから選ばせた上で個別分岐
- 通常症状分岐は4〜7個の代表的カテゴリ
- fixは1ノード1手順。2〜3段階試して未解決ならdanger_confirmへ
- 業者手配は必ずdanger_confirmのnext_call経由。AIやシステムが自動で呼ぶことは一切ない
- 「異音」は危険信号として自動エスカレーションしない。通常フローで扱う
- どの分岐も必ずresolved/escalate/cancelledのいずれかに到達する。行き止まり・無限ループ禁止
- choiceのlabelは20文字以内、選択肢は2〜7個
- 文言はすべて敬語・平易な日本語
- 出力はJSONのみ。説明文・前置き・コードフェンス不要

## 入力
- 機器種別: {{deviceType}}
- メーカー: {{maker}}
- 型番: {{model}}
- 主な用途・設置環境: 中小企業のオフィス内、複数名で共有利用
- よくある症状の例(参考、これに限らず一般的な症状を網羅すること):
  - 紙づまり / 印刷できない・反応しない / 印刷が薄い・濃い・かすれる
  - 異音がする / エラーランプ・エラー画面が出る / コピー・スキャン・FAXが使えない
  - 発煙・異臭・異常発熱・液漏れがある
(機器種別がプリンタ以外の場合は、その機器で一般的な症状に読み替えて生成してください)`;

export async function generateAndSaveTree(env, deviceType, maker, model) {
  const gemini = new GeminiClient(env.GEMINI_API_KEY);

  const prompt = PROMPT_TEMPLATE
    .replaceAll('{{deviceType}}', deviceType)
    .replaceAll('{{maker}}', maker || '共通')
    .replaceAll('{{model}}', model || '共通');

  const treeJson = await gemini.generateJson(prompt);

  if (!treeJson) {
    await _notifyAdminFailure(env, deviceType, maker, model, 'Gemini API呼び出し失敗');
    return { success: false, reason: 'gemini_call_failed' };
  }

  const validation = validateTree(treeJson);
  if (!validation.valid) {
    await _notifyAdminFailure(env, deviceType, maker, model, `検証エラー: ${validation.errors.slice(0, 3).join(' / ')}`);
    return { success: false, reason: 'validation_failed', errors: validation.errors };
  }

  const treeId = treeJson.tree_id || `${deviceType}_${maker}_${model}_v1`;
  await env.DB.prepare(`
    INSERT INTO diagnosis_trees (tree_id, device_type, maker, model_pattern, tree_json, is_verified, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(tree_id) DO UPDATE SET tree_json = excluded.tree_json, is_verified = 1, updated_at = excluded.updated_at
  `).bind(treeId, deviceType, maker || '共通', model || '共通', JSON.stringify(treeJson), new Date().toISOString()).run();

  return { success: true, treeId };
}

async function _notifyAdminFailure(env, deviceType, maker, model, reason) {
  if (!env.AZENT_ADMIN_LINE_ID) return;
  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  await line.push(
    env.AZENT_ADMIN_LINE_ID,
    `【要確認】症状ツリー自動生成に失敗しました\n機種: ${deviceType} ${maker || ''} ${model || ''}\n理由: ${reason}\n(この機種は共通版ツリーで動作します。手動確認をお願いします)`
  );
}
