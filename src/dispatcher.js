/**
 * 業者ディスパッチエンジン
 */

import { LineClient } from './lineClient.js';

const TIMEOUT_MINUTES = 10;

export class Dispatcher {
  constructor(env) {
    this.db = env.DB;
    this.line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
    this.vendorLine = new LineClient(env.VENDOR_LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_ACCESS_TOKEN);
    this.adminLineId = env.AZENT_ADMIN_LINE_ID || null;
  }

  async dispatch(companyId, symptomText, matchedStatus) {
    const dispatchId = `D${Date.now()}`;
    const now = new Date().toISOString();

    const vendor = await this.db.prepare(
      'SELECT * FROM vendors ORDER BY priority ASC LIMIT 1'
    ).first();

    await this.db.prepare(`
      INSERT INTO dispatch_log
        (dispatch_id, company_id, symptom, matched_status, vendor_id, dispatched_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).bind(dispatchId, companyId, symptomText, matchedStatus, vendor?.vendor_id || null, now).run();

    if (vendor?.line_id) {
      const company = await this.db.prepare(
        'SELECT * FROM companies WHERE company_id = ?'
      ).bind(companyId).first();
      await this._notifyVendor(vendor.line_id, dispatchId, company, symptomText);
    } else {
      await this._escalateToAdmin(dispatchId, companyId, symptomText, '業者未登録');
    }

    return dispatchId;
  }

  async acceptDispatch(vendorId, dispatchId = null) {
    const log = dispatchId
      ? await this.db.prepare(`
          SELECT dl.*, c.company_name FROM dispatch_log dl
          JOIN companies c ON dl.company_id = c.company_id
          WHERE dl.vendor_id = ? AND dl.dispatch_id = ? AND dl.status = 'pending'
        `).bind(vendorId, dispatchId).first()
      : await this.db.prepare(`
          SELECT dl.*, c.company_name FROM dispatch_log dl
          JOIN companies c ON dl.company_id = c.company_id
          WHERE dl.vendor_id = ? AND dl.status = 'pending'
          ORDER BY dl.dispatched_at ASC LIMIT 1
        `).bind(vendorId).first();

    if (!log) return null;

    await this.db.prepare(`
      UPDATE dispatch_log SET status = 'accepted', responded_at = ? WHERE dispatch_id = ?
    `).bind(new Date().toISOString(), log.dispatch_id).run();

    return { dispatch_id: log.dispatch_id, company_id: log.company_id, company_name: log.company_name };
  }

  async setEtaAndNotifyCustomer(vendorId, dispatchId, etaMinutes, etaLabel) {
    const log = await this.db.prepare(`
      SELECT dl.*, c.company_name, c.group_line_id, c.approver_line_id
      FROM dispatch_log dl
      JOIN companies c ON dl.company_id = c.company_id
      WHERE dl.vendor_id = ? AND dl.dispatch_id = ? AND dl.status = 'accepted'
    `).bind(vendorId, dispatchId).first();

    if (!log) return null;

    await this.db.prepare(`
      UPDATE dispatch_log SET eta_minutes = ? WHERE dispatch_id = ?
    `).bind(etaMinutes, dispatchId).run();

    const vendor = await this.db.prepare(
      'SELECT * FROM vendors WHERE vendor_id = ?'
    ).bind(vendorId).first();

    const notifyTarget = log.group_line_id || log.approver_line_id;
    if (notifyTarget) {
      await this.line.push(
        notifyTarget,
        [
          `担当者が手配できました。`,
          `業者: ${vendor?.vendor_name || '提携業者'}`,
          `到着予定: 約${etaLabel}`,
          `案件ID: ${dispatchId}`,
          ``,
          `今しばらくお待ちください。`
        ].join('\n')
      );
    }

    return { company_name: log.company_name };
  }

  async checkTimeouts() {
    const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();
    const timedOut = await this.db.prepare(`
      SELECT * FROM dispatch_log WHERE status = 'pending' AND dispatched_at < ?
    `).bind(cutoff).all();

    for (const log of (timedOut.results || [])) {
      await this._forwardToNext(log);
    }
  }

  async _forwardToNext(log) {
    const currentVendor = log.vendor_id
      ? await this.db.prepare('SELECT * FROM vendors WHERE vendor_id = ?').bind(log.vendor_id).first()
      : null;
    const currentPriority = currentVendor?.priority || 0;

    const nextVendor = await this.db.prepare(
      'SELECT * FROM vendors WHERE priority > ? ORDER BY priority ASC LIMIT 1'
    ).bind(currentPriority).first();

    if (!nextVendor) {
      await this.db.prepare(
        `UPDATE dispatch_log SET status = 'escalated' WHERE dispatch_id = ?`
      ).bind(log.dispatch_id).run();
      await this._escalateToAdmin(log.dispatch_id, log.company_id, log.symptom, '全業者未応答');
      return;
    }

    await this.db.prepare(`
      UPDATE dispatch_log SET vendor_id = ?, dispatched_at = ? WHERE dispatch_id = ?
    `).bind(nextVendor.vendor_id, new Date().toISOString(), log.dispatch_id).run();

    if (nextVendor.line_id) {
      const company = await this.db.prepare(
        'SELECT * FROM companies WHERE company_id = ?'
      ).bind(log.company_id).first();
      await this._notifyVendor(nextVendor.line_id, log.dispatch_id, company, log.symptom);
    }
  }

  async _notifyVendor(vendorLineId, dispatchId, company, symptom) {
    const devices = await this.db.prepare(
      'SELECT device_type, maker, model FROM devices WHERE company_id = ?'
    ).bind(company?.company_id).all();

    const deviceList = (devices.results || [])
      .map(d => `・${d.device_type} ${d.maker || ''}${d.model || ''}`)
      .join('\n');

    const title = [
      `【案件通知】A-Zent`,
      `会社: ${company?.company_name || '不明'}`,
      `住所: ${company?.address || '不明'}`,
      `症状: ${symptom}`,
      deviceList ? `\n【保有機器】\n${deviceList}` : ''
    ].filter(Boolean).join('\n');

    await this.vendorLine.pushButtons(
      vendorLineId,
      `【案件通知】${company?.company_name || ''} - ${symptom}`,
      title,
      [{ label: '受注する', data: `action=accept&dispatch_id=${dispatchId}` }]
    );
  }

  async _escalateToAdmin(dispatchId, companyId, symptom, reason) {
    if (!this.adminLineId) {
      console.error(`エスカレーション発生(管理者LINE ID未設定): ${dispatchId} / ${reason}`);
      return;
    }
    await this.line.push(
      this.adminLineId,
      `【要対応】業者手配が完了していません\n理由: ${reason}\n案件ID: ${dispatchId}\n症状: ${symptom}`
    );
  }
}
