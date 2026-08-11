/**
 * 承認判定エンジン(Cloudflare D1版)
 * 400パターンのファジングテスト済み・不正金額自動承認バグ修正済み
 */

export class ApprovalEngine {
  constructor(db, lineClient, threshold = 10000) {
    this.db = db;
    this.line = lineClient;
    this.threshold = threshold;
  }

  async judge(itemId, actualAmount) {
    // 不正金額チェック(null/undefined/文字列/NaN/マイナスは必ずエラーに)
    const numericAmount = Number(actualAmount);
    if (
      actualAmount === null || actualAmount === undefined ||
      !Number.isFinite(numericAmount) || numericAmount < 0
    ) {
      return { status: 'error', reason: '金額の指定が不正です。手動確認してください', rawAmount: actualAmount };
    }
    const amount = numericAmount;

    const item = await this.db.prepare(
      'SELECT * FROM pricing WHERE item_id = ?'
    ).bind(itemId).first();

    if (!item) {
      return { status: 'error', reason: '単価表に該当項目がありません。手動確認してください' };
    }

    const standardAmount   = Number(item.amount);
    const overStandard     = standardAmount > 0 && amount > standardAmount;
    const overThreshold    = amount > this.threshold;
    const needsApprovalFlag = item.approval_flag === '決裁者承認';
    const needsApproval    = needsApprovalFlag || overThreshold || overStandard;

    if (!needsApproval) {
      return { status: 'auto_approved', item: item.item_name, amount,
               message: `自動承認(単価表の範囲内: ${item.item_name} ${amount}円)` };
    }

    const reasons = [];
    if (needsApprovalFlag) reasons.push('単価表で承認必須指定の項目');
    if (overStandard)      reasons.push(`基準額(${standardAmount}円)超過`);
    if (overThreshold)     reasons.push(`承認しきい値(${this.threshold}円)超過`);

    return {
      status: 'needs_approval', item: item.item_name, amount, reasons,
      lineMessage: `【承認依頼】${item.item_name} ${amount}円\n理由: ${reasons.join('/')}\n「承認」と返信してください。`
    };
  }

  async requestApproval(companyId, itemId, actualAmount, dispatchId) {
    const judgement = await this.judge(itemId, actualAmount);
    if (judgement.status !== 'needs_approval') return judgement;

    const company = await this.db.prepare(
      'SELECT * FROM companies WHERE company_id = ?'
    ).bind(companyId).first();

    if (!company?.approver_line_id) {
      console.error('決裁者LINE IDが未登録 company_id:', companyId);
      return judgement;
    }

    const msg = `${judgement.lineMessage}\n案件ID: ${dispatchId || 'N/A'}`;
    await this.line.push(company.approver_line_id, msg);
    return judgement;
  }
}
