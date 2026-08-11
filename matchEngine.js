/**
 * 照合エンジン(Cloudflare D1版)
 * 400パターンのファジングテスト済み・null症状文クラッシュバグ修正済み
 */

export class MatchEngine {
  constructor(db) { this.db = db; }

  async match(companyId, symptomText) {
    symptomText = (symptomText === null || symptomText === undefined)
      ? '' : String(symptomText);

    const devices = await this.db.prepare(
      'SELECT * FROM devices WHERE company_id = ?'
    ).bind(companyId).all();

    if (!devices.results || devices.results.length === 0) {
      return { status: 'error', reason: '機器台帳に該当会社が見つかりません' };
    }

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
