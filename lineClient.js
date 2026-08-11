/**
 * LINE Messaging APIクライアント
 * reply(replyToken付き返信) / push(任意のuserIdへ送信) / multicast(一括送信)
 */

const LINE_API = 'https://api.line.me/v2/bot/message';

export class LineClient {
  constructor(token) { this.token = token; }

  async reply(replyToken, text) {
    if (!this.token || !replyToken) return;
    await fetch(`${LINE_API}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text) }] })
    });
  }

  async push(lineUserId, text) {
    if (!this.token || !lineUserId) return;
    await fetch(`${LINE_API}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: String(text) }] })
    });
  }

  async multicast(lineUserIds, text) {
    if (!this.token || !lineUserIds?.length) return;
    await fetch(`${LINE_API}/multicast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ to: lineUserIds, messages: [{ type: 'text', text: String(text) }] })
    });
  }
}
