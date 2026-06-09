# シェリー 予約カルテ印刷 拡張機能

トリミング予約SaaS「シェリー」(cheriee.biz) の予約詳細を、自店「ご予約カルテ」フォーマットで
印刷／PDF保存する Chrome 拡張です。仕様書 v0.2 準拠。

## 仕組み

ページがシェリーの詳細API
（`GET https://api.cheriee.jp/v2/companies/{companyId}/schedules/{scheduleId}`）を叩いた
レスポンスを **横取り（パッシブキャプチャ）** してカルテに流し込みます。JWT を自前で抜く・保存する
必要がなく、追加の API 呼び出しも host 権限も不要です。トークン・PII は拡張内のメモリでのみ使用し、
外部送信・永続化しません。

```
entrypoints/
  interceptor.content.ts  MAINワールド。fetch/XHR をパッチし schedules/{id} の
                          レスポンスを捕捉 → window.postMessage で渡す
  ui.content.ts           ISOLATEDワールド。印刷ボタン注入 / 捕捉データ受信 / 印刷ビュー起動
lib/
  types.ts                APIレスポンス型 & メッセージ型
  mapResponseToKarte.ts   レスポンス → カルテ項目（JST変換・年齢・泊数算出）
  renderKarte.ts          カルテHTML生成（印刷CSS込みの完全なHTML）
```

印刷は **HTML + 印刷CSS → `window.print()`**。`ui.content.ts` が `window.open()` した
ウィンドウへカルテHTMLを書き込み、印刷ダイアログを開きます。ブラウザの「PDFに保存」がそのまま使えます。

## 使い方（開発）

```bash
npm install         # 依存インストール（postinstall で wxt prepare）
npm run dev         # Chrome を起動して拡張を読み込み、ホットリロード開発
npm run build       # .output/chrome-mv3 に本番ビルド
npm run compile     # 型チェック（tsc --noEmit）
npm run zip         # 配布用 zip 作成
```

### 手動で読み込む場合
`npm run build` 後、Chrome の `chrome://extensions` →「デベロッパーモード」ON →
「パッケージ化されていない拡張機能を読み込む」で `.output/chrome-mv3` を選択。

### 動作
1. シェリーで予約詳細を開く（→ 詳細APIが走り、レスポンスを自動捕捉）。
2. 画面右下の **🖨 印刷** ボタン（または詳細ツールバーの「編集」隣の印刷ボタン）をクリック。
3. カルテが新ウィンドウで開き、印刷ダイアログが出ます。

予約を一度も開かずに押した場合は「予約を開いてから印刷してください」と案内します（横取り未取得ガード）。

## プレビュー

`sample-karte.html` は付録Aの実例データでレンダリングしたカルテ見本です。ブラウザで開くと
レイアウトを確認できます（このファイルは拡張本体には含まれません）。

## 設定（コード内）

`entrypoints/ui.content.ts` 冒頭の定数で調整します。

| 定数 | 既定 | 内容 |
|---|---|---|
| `INCLUDE_CONTACT` | `true` | 連絡先（住所・電話, PII）をカルテに載せるか（§6・要確認⑤） |
| `STAFF_NAMES` | `{}` | `staffId → スタッフ名` の辞書（§5・要確認②）。空なら ID 表示 |

## 自動入力される項目 / 手書きの項目

レスポンスから取れる項目（区分・受付者・受付日・名前・犬種・性別・年齢・期間・IN/OUT・泊数・
会計済未・予定金額・お薬・その他・備考・連絡先）は自動入力。

レスポンスに存在しない項目（**アレルギー / お散歩 / 室内トイレ / 他の犬 / トイレシーツ /
お預かり物**）は空チェック欄で出力し、印刷後の手書きに委ねます（カルテ下部に注記）。

## 未確定事項（仕様書 §9）

| # | 内容 | 状況 |
|---|---|---|
| ① | 印刷ボタン配置 | フローティング（確実）＋ツールバー注入（ベストエフォート）で実装済み。実DOM確定後にツールバーセレクタを精緻化 |
| ② | スタッフ名の解決 | `STAFF_NAMES` 辞書 or マスタAPIで解決。未指定時は ID 表示 |
| ③ | トリミング予約の `details` 中身 | `details[]` を `name ×quantity` で列挙。実サンプル確認後に項目調整 |
| ④ | アレルギー/散歩OK等の所在 | レスポンスに無し → 手書き。別エンドポイント判明後に補助方式（トークン捕捉＋再フェッチ）で補完 |
| ⑤ | 印刷レイアウト & 連絡先掲載 | ハーフ版1枚で実装。連絡先は `INCLUDE_CONTACT` で切替 |

## 技術メモ

- 時刻はすべて UTC(Z)。`Intl.DateTimeFormat(timeZone: 'Asia/Tokyo')` で +9h 変換。
- 泊数は `startedAt`/`endedAt` の JST 暦日差で算出（`totalTime` は 0 のことがあり使わない）。同日内は泊数欄を空に。
- 年齢は `animal.birthday` から JST 基準日で満年齢を算出。
- キャンセル系ステータス（`/CANCEL/i`）は印刷前に確認ダイアログ＋カルテ上部に警告バナー。
