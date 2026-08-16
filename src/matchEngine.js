/**
 * 照合エンジン(Cloudflare D1版) v5
 *
 * v5変更点:
 *   「登録機器が1台なら自動回答」を廃止。症状から機器種別さえ
 *   特定できれば、必ずその種別の登録機器一覧(+「登録されていない
 *   機器」選択肢)を提示してCLに選ばせる方式に統一。
 *   選択後の個別照合は matchForDevice() が担う。
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

const NEW_DEVICE_SENTINEL = '__new__';

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

    if (!devices.results) {
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

    // 症状文から機器種別を推定(会社の登録機器を問わず、共通ナレッジ全体から)
    const guessedType = this._guessDeviceType(symptomText, knowledge);
    if (!guessedType) {
      return { status: 'no_match', reason: '症状から機器種別を特定できませんでした' };
    }

    const ownedOfType = devices.results.filter(d => d.device_type === guessedType);

    if (ownedOfType.length === 0) {
      return { status: 'needs_device_registration', deviceType: guessedType };
    }

    // 登録台数によらず、必ず機器一覧+「登録されていない機器」を選ばせる
    const options = ownedOfType.map(d => ({
      device_id: d.device_id,
      label: `${d.maker || ''}${d.model || ''}(${d.location || ''})`
    }));
    options.push({ device_id: NEW_DEVICE_SENTINEL, label: '登録されていない機器' });

    return { status: 'needs_device_selection', deviceType: guessedType, options, symptomText };
  }

  /** 機種選択後、選ばれた機器に対して直接照合する */
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
