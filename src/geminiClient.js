/**
 * Google Gemini API クライアント(症状診断ツリー自動生成用)
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.0-flash';

export class GeminiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * プロンプトを渡してテキスト(JSON文字列を想定)を生成する
   */
  async generateJson(prompt) {
    if (!this.apiKey) {
      console.error('GeminiClient: APIキーが設定されていません');
      return null;
    }

    const url = `${GEMINI_API_BASE}/${MODEL}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('GeminiClient.generateJson failed:', res.status, errBody);
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('GeminiClient.generateJson: レスポンスにテキストがありません', JSON.stringify(data));
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      console.error('GeminiClient.generateJson: JSONパース失敗', e.message, text.slice(0, 500));
      return null;
    }
  }
}
