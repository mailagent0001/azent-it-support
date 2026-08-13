/**
 * LINE Messaging APIクライアント
 */

const LINE_API = 'https://api.line.me/v2/bot/message';

export class LineClient {
  constructor(token) { this.token = token; }

  async _post(path, body) {
    const res = await fetch(`${LINE_API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`LineClient.${path} failed:`, res.status, errBody);
    }
    return res;
  }

  async reply(replyToken, text) {
    if (!this.token || !replyToken) {
      console.error('LineClient.reply: token or replyToken missing');
      return;
    }
    await this._post('reply', { replyToken, messages: [{ type: 'text', text: String(text) }] });
  }

  async push(lineUserId, text) {
    if (!this.token || !lineUserId) {
      console.error('LineClient.push: token or lineUserId missing');
      return;
    }
    await this._post('push', { to: lineUserId, messages: [{ type: 'text', text: String(text) }] });
  }

  async multicast(lineUserIds, text) {
    if (!this.token || !lineUserIds?.length) return;
    await this._post('multicast', { to: lineUserIds, messages: [{ type: 'text', text: String(text) }] });
  }

  /** ボタン付きメッセージ(最大4個) */
  async pushButtons(lineUserId, altText, titleText, buttons) {
    if (!this.token || !lineUserId) return;
    const message = {
      type: 'template',
      altText,
      template: {
        type: 'buttons',
        text: titleText.slice(0, 160),
        actions: buttons.map(b => ({
          type: 'postback', label: b.label.slice(0, 20), data: b.data, displayText: b.label
        }))
      }
    };
    await this._post('push', { to: lineUserId, messages: [message] });
  }

  /**
   * ボタン付きメッセージ + 続けて通常テキストメッセージ(URLなど)をまとめて送る。
   * LINEは1回のpushで最大5メッセージまで送信可能。
   */
  async pushButtonsWithFollowup(lineUserId, altText, titleText, buttons, followupText) {
    if (!this.token || !lineUserId) return;
    const buttonMessage = {
      type: 'template',
      altText,
      template: {
        type: 'buttons',
        text: titleText.slice(0, 160),
        actions: buttons.map(b => ({
          type: 'postback', label: b.label.slice(0, 20), data: b.data, displayText: b.label
        }))
      }
    };
    const messages = [buttonMessage];
    if (followupText) {
      messages.push({ type: 'text', text: String(followupText) });
    }
    await this._post('push', { to: lineUserId, messages });
  }

  /** replyTokenに対してテキスト+Quick Reply(最大13個)を返信 */
  async replyWithQuickReply(replyToken, text, items) {
    if (!this.token || !replyToken) return;
    const message = {
      type: 'text',
      text,
      quickReply: {
        items: items.map(it => ({
          type: 'action',
          action: { type: 'postback', label: it.label.slice(0, 20), data: it.data, displayText: it.label }
        }))
      }
    };
    await this._post('reply', { replyToken, messages: [message] });
  }
}
