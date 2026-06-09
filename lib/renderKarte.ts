import type { Karte } from './mapResponseToKarte';

/** HTMLエスケープ（描画値はすべて通す） */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** チェックボックス（■=選択 / □=未選択）。auto判定済みは塗る。 */
function box(label: string, checked: boolean): string {
  return `<span class="cb">${checked ? '■' : '□'}</span>${esc(label)}`;
}

/** 値 or 空（手書き用の下線スペース） */
function val(s: string): string {
  return s ? esc(s) : '<span class="blank"></span>';
}

export interface RenderOptions {
  /** 連絡先（住所・電話, PII）を載せるか（§6・要確認⑤） */
  includeContact?: boolean;
}

/**
 * カルテ1枚分の完全なHTMLドキュメント文字列を生成する。
 * 印刷ウィンドウへ document.write して `window.print()` する想定（依存ライブラリ無し）。
 */
export function renderKarte(k: Karte, opts: RenderOptions = {}): string {
  const includeContact = opts.includeContact ?? true;

  // S/SC/内容: details があれば列挙、無ければ手書き空欄
  const detailsRows =
    k.details.length > 0
      ? k.details.map((d) => `<div class="detail-item">${esc(d)}</div>`).join('')
      : '<div class="detail-item blank-line"></div><div class="detail-item blank-line"></div>';

  const contactBlock = includeContact
    ? `
      <table class="karte-table contact">
        <tr>
          <th class="label">お客様</th>
          <td colspan="3">${val(k.contact.name)}</td>
        </tr>
        <tr>
          <th class="label">ご住所</th>
          <td colspan="3">${k.contact.postalCode ? `〒${esc(k.contact.postalCode)} ` : ''}${val(k.contact.address)}</td>
        </tr>
        <tr>
          <th class="label">お電話</th>
          <td colspan="3">${val(k.contact.tel)}</td>
        </tr>
      </table>`
    : '';

  const canceledBanner = k.canceled
    ? `<div class="canceled-banner">⚠ この予約はキャンセル系ステータス（${esc(k.status)}）です</div>`
    : '';

  const title = k.animalName
    ? `ご予約カルテ — ${esc(k.animalName)}`
    : 'ご予約カルテ';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
    color: #111; margin: 0; padding: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .karte {
    width: 190mm; margin: 0 auto; padding: 4mm 0;
  }
  .karte-header {
    display: flex; align-items: baseline; justify-content: space-between;
    border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 6px;
  }
  .karte-header h1 { font-size: 18px; margin: 0; }
  .karte-header .code { font-size: 12px; color: #555; }
  .canceled-banner {
    background: #ffe0e0; border: 1px solid #c00; color: #900;
    padding: 4px 8px; margin-bottom: 6px; font-size: 12px; border-radius: 3px;
  }
  table.karte-table {
    width: 100%; border-collapse: collapse; margin-bottom: 6px;
    font-size: 12px; table-layout: fixed;
  }
  table.karte-table th, table.karte-table td {
    border: 1px solid #888; padding: 4px 6px; vertical-align: middle;
    word-break: break-all;
  }
  table.karte-table th.label {
    background: #f2f2f2; width: 22mm; text-align: left; font-weight: 600;
    white-space: nowrap;
  }
  .cb { display: inline-block; margin-right: 2px; font-size: 13px; }
  .checks span + .cb { margin-left: 10px; }
  .blank { display: inline-block; min-width: 60px; border-bottom: 1px dotted #aaa; }
  .blank-line { min-height: 14px; border-bottom: 1px dotted #aaa; }
  .detail-item { padding: 1px 0; }
  .big { font-size: 14px; font-weight: 600; }
  .muted { color: #666; font-size: 11px; }
  .note { font-size: 10px; color: #888; margin-top: 4px; }
  @media screen {
    body { background: #ddd; padding: 20px 0; }
    .karte { background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  }
</style>
</head>
<body>
  <div class="karte">
    <div class="karte-header">
      <h1>ご予約カルテ</h1>
      <div class="code">${k.code ? `予約番号 ${esc(k.code)}` : ''}</div>
    </div>

    ${canceledBanner}

    <table class="karte-table">
      <tr>
        <th class="label">区分</th>
        <td class="checks" colspan="3">
          ${box('トリミング', k.category === 'トリミング')}
          ${box('ホテル', k.category === 'ホテル')}
          ${box('その他', k.category === 'その他')}
          ${k.categoryLabel ? `<span class="muted">（${esc(k.categoryLabel)}）</span>` : ''}
        </td>
      </tr>
      <tr>
        <th class="label">受付者</th>
        <td>${val(k.staff)}</td>
        <th class="label">受付日</th>
        <td>${val(k.receivedDate)}</td>
      </tr>
    </table>

    <table class="karte-table">
      <tr>
        <th class="label">名前</th>
        <td class="big">${val(k.animalName)}</td>
        <th class="label">性別</th>
        <td>
          ${box('♂', k.sexMark === '♂')}
          ${box('♀', k.sexMark === '♀')}
        </td>
      </tr>
      <tr>
        <th class="label">犬種</th>
        <td>${val(k.breed)}</td>
        <th class="label">年齢</th>
        <td>${val(k.age)}</td>
      </tr>
    </table>

    <table class="karte-table">
      <tr>
        <th class="label">期間</th>
        <td colspan="3">${val(k.period)}</td>
      </tr>
      <tr>
        <th class="label">IN</th>
        <td>${val(k.inTime)}</td>
        <th class="label">OUT</th>
        <td>${val(k.outTime)}</td>
      </tr>
      <tr>
        <th class="label">泊数・日数</th>
        <td>${val(k.stay)}</td>
        <th class="label">お会計</th>
        <td>
          ${box('済', k.paid === '済')}
          ${box('未', k.paid === '未')}
          ${k.amount ? `<span class="muted">予定 ￥${esc(k.amount)}</span>` : ''}
        </td>
      </tr>
    </table>

    <table class="karte-table">
      <tr>
        <th class="label">S / SC<br>内容</th>
        <td colspan="3">${detailsRows}</td>
      </tr>
    </table>

    <table class="karte-table">
      <tr>
        <th class="label">お薬</th>
        <td>${box('有', k.medicine === '有')}${box('無', k.medicine === '無')}</td>
        <th class="label">アレルギー</th>
        <td class="checks">${box('有', false)}${box('無', false)}</td>
      </tr>
      <tr>
        <th class="label">お散歩</th>
        <td class="checks">${box('OK', false)}${box('NG', false)}</td>
        <th class="label">室内トイレ</th>
        <td class="checks">${box('OK', false)}${box('NG', false)}</td>
      </tr>
      <tr>
        <th class="label">他の犬</th>
        <td class="checks">${box('OK', false)}${box('NG', false)}</td>
        <th class="label">トイレシーツ</th>
        <td class="checks">${box('OK', false)}${box('NG', false)}</td>
      </tr>
      <tr>
        <th class="label">お預かり物</th>
        <td class="checks" colspan="3">
          ${box('ご飯', false)}${box('おやつ', false)}
          <span class="blank"></span>
        </td>
      </tr>
    </table>

    <table class="karte-table">
      <tr>
        <th class="label">その他</th>
        <td colspan="3">${val(k.other)}</td>
      </tr>
      <tr>
        <th class="label">備考</th>
        <td colspan="3">${val(k.memo)}</td>
      </tr>
    </table>

    ${contactBlock}

    <div class="note">※ チェックの無い項目（アレルギー／お散歩／室内トイレ／他の犬／トイレシーツ／お預かり物）はシステム未取得のため手書きで記入してください。</div>
  </div>
</body>
</html>`;
}
