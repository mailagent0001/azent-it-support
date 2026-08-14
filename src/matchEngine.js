/**
 * 照合エンジン(Cloudflare D1版) v4
 *
 * v4変更点:
 *   症状文から機器種別を推定し、会社の登録機器が
 *   ・複数台該当 → needs_device_selection(機種選択を促す)
 *   ・0台該当    → needs_device_registration(その場で機種登録を促す)
 *   を返せるように拡張。1台のみ該当する場合は従来通り自動回答。
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

    const devices = await this.db.prepare(
      'SELECT * FROM devices WHERE company_id = ?'
    ).bind(companyId).all();

    if (!devices.results || devices.results.length === 0) {
      return { status: 'error', reason: '機器台帳に該当会社が見つかりません' };
    }

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

    const knowledgeAll = await this.db.prepare('SELECT * FROM knowledge').all();
    const knowledge = knowledgeAll.results || [];

    // 会社の登録機器の中から、症状キーワードに一致する候補を集める
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

    if (candidates.length > 0) {
      // 一致した物理機器が複数台ある場合は選択させる
      const distinctDeviceIds = [...new Set(candidates.map(c => c.device.device_id))];
      if (distinctDeviceIds.length > 1) {
        const options = distinctDeviceIds.map(id => {
          const d = candidates.find(c => c.device.device_id === id).device;
          return { device_id: d.device_id, label: `${d.maker || ''}${d.model || ''}(${d.location || ''})` };
        });
        return { status: 'needs_device_selection', deviceType: candidates[0].device.device_type, options };
      }

      candidates.sort((a, b) => a.priority - b.priority);
      const best = candidates[0];
      return this._buildMatchedResult(best, symptomText);
    }

    // 会社の登録機器では該当なし。症状から機種を推定できるか(=未登録機種の可能性)を確認
    const guessedType = this._guessDeviceType(symptomText, knowledge);
    if (guessedType) {
      const hasType = devices.results.some(d => d.device_type === guessedType);
      if (!hasType) {
        return { status: 'needs_device_registration', deviceType: guessedType };
      }
    }

    return { status: 'no_match', reason: '該当するナレッジが見つかりません' };
  }

  /** 特定の機器IDに対して直接照合する(機種選択後や新規登録直後に使用) */
  async matchForDevice(deviceId, symptomText) {
    symptomText = (symptomText === null || symptomText === undefined)
      ? '' : String(symptomText);

    const device = await this.db.prepare(
      'SELECT * FROM devices WHERE device_id = ?'
    ).bind(deviceId).first();
    if (!device) return { status: 'error', reason: '機器が見つかりません' };

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

    const knowledgeAll = await this.db.prepare(
      'SELECT * FROM knowledge WHERE device_type = ?'
    ).bind(device.device_type).all();
    const knowledge = knowledgeAll.results || [];

    let candidates = [];
    for (const k of knowledge) {
      const keywords = k.symptom_keywords.split(';');
      const hit = keywords.some(kw => kw && symptomText.includes(kw));
      if (!hit) continue;
      const isExact    = k.maker === device.maker && k.model_pattern === device.model;
      const isFallback = k.maker === '共通' && k.model_pattern === '共通';
      if (isExact || isFallback) {
        candidates.push({ device, knowledge: k, priority: isExact ? 1 : 2 });
      }
    }

    if (candidates.length === 0) {
      return { status: 'no_match', reason: '該当するナレッジが見つかりません' };
    }

    candidates.sort((a, b) => a.priority - b.priority);
    return this._buildMatchedResult(candidates[0], symptomText);
  }

  /** 症状キーワードから機器種別を推定(会社の登録機器を問わず、ナレッジ全体から) */
  _guessDeviceType(symptomText, knowledge) {
    for (const k of knowledge) {
      if (k.maker !== '共通' || k.model_pattern !== '共通') continue;
      const keywords = k.symptom_keywords.split(';');
      const hit = keywords.some(kw => kw && symptomText.includes(kw));
      if (hit) return k.device_type;
    }
    return null;
  }

  _buildMatchedResult(best, symptomText) {
    const escConditions = (best.knowledge.escalation_criteria || '').split(';');
    const needsEscalation = escConditions.some(c =>
      c && symptomText.includes(c.replace(/場合$/, ''))
    );

    return {
      status: needsEscalation ? 'escalate_immediately' : 'matched',
      device: `${best.device.maker} ${best.device.model}(${best.device.location})`,
      deviceMaker: best.device.maker,
      deviceModel: best.device.model,
      matchType: best.priority === 1 ? '型番専用ルール' : '汎用フォールバック',
      diagnosis: best.knowledge.diagnosis,
      fix: best.knowledge.fix,
      escalationCriteria: best.knowledge.escalation_criteria,
      knowledgeId: best.knowledge.knowledge_id
    };
  }
}
