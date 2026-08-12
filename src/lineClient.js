/**
 * LINE Messaging APIクライアント
 * reply(replyToken付き返信) / push(任意のuserIdへ送信) / multicast(一括送信)
 */

const LINE_API = 'https://api.line.me/v2/bot/message';

export class LineClient {
  constructor(token) { this.token = token; }

  async reply(replyToken, text) {
    if (!this.token || !replyToken) {
      console.error('LineClient.reply: token or replyToken missing', { hasToken: !!this.token, replyToken });
      return;
    }
    const res = await fetch(`${LINE_API}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text) }] })
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('LineClient.reply failed:', res.status, errBody);
    }
  }

  async push(lineUserId, text) {
    if (!this.token || !lineUserId) {
      console.error('LineClient.push: token or lineUserId missing', { hasToken: !!this.token, lineUserId });
      return;
    }
    const res = await fetch(`${LINE_API}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: String(text) }] })
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('LineClient.push failed:', res.status, errBody);
    }
  }

  async multicast(lineUserIds, text) {
    if (!this.token || !lineUserIds?.length) {
      console.error('LineClient.multicast: token or lineUserIds missing');
      return;
    }
    const res = await fetch(`${LINE_API}/multicast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ to: lineUserIds, messages: [{ type: 'text', text: String(text) }] })
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('LineClient.multicast failed:', res.status, errBody);
    }
  }
}
