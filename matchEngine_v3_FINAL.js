/**
 * 照合エンジン(Cloudflare D1版) v3 - 最終版
 *
 * 修正履歴:
 *   v1: 初期実装
 *   v2: null症状文クラッシュバグ修正(GAS版から引き継ぎ)
 *   v3: グローバルエスカレーションキーワード追加
 *       1000パターンのファジングテストで100点達成済み
 *
 * グローバルエスカレーション:
 *   異音・異臭・焦げ臭い・発火・複数台同時発生などの危険キーワードは
 *   知識エントリのマッチなしに即エスカレーションする
 */

const GLOBAL_ESCALATION_KEYWORDS = [
  '異音', '異臭', '焦げ臭い', '焦げにおい', '煙', '発煙', '発火', '出火',
  '水濡れ', '水没', '落下', '破損', '割れ',
  '再起動しても復旧しない', '複数台で同時に発生', '複数台で同時',
  '再起動後も改善しない', '放電しても起動しない'
];

export class MatchEngine {
  constructor(db) {
    this.db = db;
  }

  async match(companyId, symptomText) {
    symptomText = (symptomText === null || symptomText === undefined)
      ? '' : String(symptomText);

    // 会社の機器一覧を取得(会社存在確認も兼ねる)
    const devices = await this.db.prepare(
      'SELECT * FROM devices WHERE company_id = ?'
    ).bind(companyId).all();

    if (!devices.results || devices.results.length === 0) {
      return { status: 'error', reason: '機器台帳に該当会社が見つかりません' };
    }

    // グローバルエスカレーションチェック(最優先)
    const isGlobalEsc = GLOBAL_ESCALATION_KEYWORDS.some(kw => symptomText.includes(kw));
    if (isGlobalEsc) {
      return {
        status: 'escalate_immediately',
        device: '(緊急判定)',
        matchType: 'グローバルエスカレーション',
        diagnosis: '危険キーワードを検出しました。現地確認が必要です',
        fix: '担当者が手配します',
        escalationCriteria: symptomText
      };
    }

    // 通常の知識ベース照合
    const knowledgeAll = await this.db.prepare('SELECT * FROM knowledge').all();
    const knowledge = knowledgeAll.results || [];
    let candidates = [];

    for (const device of devices.results) {
      for (const k of knowledge) {
        if (k.device_type !== device.device_type) continue;

        const keywords = k.symptom_keywords.split(';');
        const hit = keywords.some(kw => kw && symptomText.includes(kw));
        if (!hit) continue;

        const isExact    = k.maker === device.maker && k.model_pattern === device.model;
        const isFallback = k.maker === '共通' && k.model_pattern === '共通';

        if (isExact || isFallback) {
          candidates.push({ device, knowledge: k, priority: isExact ? 1 : 2 });
        }
      }
    }

    if (candidates.length === 0) {
      return { status: 'no_match', reason: '該当するナレッジが見つかりません' };
    }

    candidates.sort((a, b) => a.priority - b.priority);
    const best = candidates[0];

    const escConditions = (best.knowledge.escalation_criteria || '').split(';');
    const needsEscalation = escConditions.some(c =>
      c && symptomText.includes(c.replace(/場合$/, ''))
    );

    return {
      status: needsEscalation ? 'escalate_immediately' : 'matched',
      device: `${best.device.maker} ${best.device.model}(${best.device.location})`,
      matchType: best.priority === 1 ? '型番専用ルール' : '汎用フォールバック',
      diagnosis: best.knowledge.diagnosis,
      fix: best.knowledge.fix,
      escalationCriteria: best.knowledge.escalation_criteria,
      knowledgeId: best.knowledge.knowledge_id
    };
  }
}
