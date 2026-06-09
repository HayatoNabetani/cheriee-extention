import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'シェリー 予約カルテ印刷',
    description:
      'シェリーの予約詳細を自店「ご予約カルテ」フォーマットで印刷／PDF保存します。',
    version: '0.2.0',
    // 補助方式（トークン捕捉＋再フェッチ）を将来有効化する場合に備えたコメント。
    // v1 ではレスポンス横取りのみで完結するため host_permissions は不要。
    // host_permissions: ['https://api.cheriee.jp/*'],
    permissions: [],
  },
});
