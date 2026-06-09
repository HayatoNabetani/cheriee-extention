import { isScheduleCapturedMessage, type ScheduleCapturedMessage } from '@/lib/types';
import { mapResponseToKarte, type Karte } from '@/lib/mapResponseToKarte';
import { renderKarte, renderKartes } from '@/lib/renderKarte';

/**
 * ISOLATEDワールド。interceptor(MAIN) が横取りしたレスポンスを受信してキャッシュし、
 * 予約詳細に「🖨 印刷」「🖨 一括印刷」ボタンを出す。
 *
 * - 単票印刷: 現在開いている予約をカルテ印刷。
 * - 一括印刷: これまでに開いた（＝キャッシュ済みの）予約から選んでまとめて印刷。
 *
 * 印刷は非表示 iframe 経由で行い、別ウィンドウを開かず印刷ダイアログのみ出す。
 *
 * 〔要確認①〕ボタン配置: 実DOM未確定のためフローティングを基本、ツールバーにも注入。
 * 〔要確認⑤〕連絡先(PII)掲載: INCLUDE_CONTACT で切替（既定: 掲載）。
 * 〔要確認②〕スタッフ名: STAFF_NAMES に辞書を入れれば ID→名前を解決。空なら ID 表示。
 */
export default defineContentScript({
  matches: ['https://cheriee.biz/*'],
  runAt: 'document_end',
  world: 'ISOLATED',
  main() {
    const PREFIX = 'cheriee-karte';
    const INCLUDE_CONTACT = true; // §6 要確認⑤
    const STAFF_NAMES: Record<number, string> = {}; // §5 要確認②

    /** scheduleId → 捕捉メッセージ。開いた予約を覚えておき一括/再印刷を可能に。 */
    const cache = new Map<string, ScheduleCapturedMessage>();
    let latestId: string | null = null;

    const mapOpts = { staffNames: STAFF_NAMES };

    /* ───────── 捕捉データ受信 ───────── */
    window.addEventListener('message', (event) => {
      if (event.source !== window) return; // 同一ウィンドウのみ
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!isScheduleCapturedMessage(data)) return;
      cache.set(data.scheduleId, data);
      latestId = data.scheduleId;
      updateButtons();
    });

    /* ───────── 印刷対象（単票）の決定 ─────────
     * URL に数値 scheduleId があり捕捉済みならそれを優先。それ以外は最新の捕捉。 */
    function getTargetId(): string | null {
      const m = /\/schedules\/(\d+)/.exec(window.location.pathname);
      if (m && m[1] && cache.has(m[1])) return m[1];
      return latestId;
    }

    /* ───────── 非表示iframeで印刷（別ウィンドウを開かない） ───────── */
    function printHtml(html: string): void {
      const iframe = document.createElement('iframe');
      Object.assign(iframe.style, {
        position: 'fixed',
        right: '0',
        bottom: '0',
        width: '0',
        height: '0',
        border: '0',
        visibility: 'hidden',
      } satisfies Partial<CSSStyleDeclaration>);
      iframe.setAttribute('aria-hidden', 'true');
      document.body.appendChild(iframe);

      const cleanup = () => {
        // 印刷ダイアログを閉じた後に少し待ってから除去
        window.setTimeout(() => iframe.remove(), 500);
      };

      const doPrint = () => {
        const win = iframe.contentWindow;
        if (!win) {
          iframe.remove();
          return;
        }
        win.addEventListener('afterprint', cleanup, { once: true });
        try {
          win.focus();
          win.print();
        } catch {
          iframe.remove();
          return;
        }
        // afterprint が発火しない環境向けの保険
        window.setTimeout(cleanup, 60_000);
      };

      const doc = iframe.contentWindow?.document;
      if (!doc) {
        iframe.remove();
        return;
      }
      doc.open();
      doc.write(html);
      doc.close();

      if (doc.readyState === 'complete') {
        window.setTimeout(doPrint, 200);
      } else {
        iframe.addEventListener('load', () => window.setTimeout(doPrint, 200));
      }
    }

    /** キャンセル系を含む場合の確認。OKなら true。 */
    function confirmCanceled(kartes: Karte[]): boolean {
      const canceled = kartes.filter((k) => k.canceled);
      if (canceled.length === 0) return true;
      const names =
        canceled.map((k) => k.animalName || '(名称不明)').join('、') || '';
      return confirm(
        `キャンセル系ステータスの予約が ${canceled.length} 件含まれます（${names}）。\nそのまま印刷しますか？`,
      );
    }

    /* ───────── 単票印刷 ───────── */
    function printSingle(): void {
      const id = getTargetId();
      const captured = id ? cache.get(id) : undefined;
      if (!captured) {
        alert(
          '印刷対象の予約データを取得できていません。\n予約を開いてから印刷してください。',
        );
        return;
      }
      const karte = mapResponseToKarte(captured.data, mapOpts);
      if (!confirmCanceled([karte])) return;
      printHtml(renderKarte(karte, { includeContact: INCLUDE_CONTACT }));
    }

    /* ───────── 一括印刷 ───────── */
    function printBatch(ids: string[]): void {
      const kartes = ids
        .map((id) => cache.get(id))
        .filter((c): c is ScheduleCapturedMessage => c != null)
        .map((c) => mapResponseToKarte(c.data, mapOpts));
      if (kartes.length === 0) return;
      if (!confirmCanceled(kartes)) return;
      printHtml(renderKartes(kartes, { includeContact: INCLUDE_CONTACT }));
    }

    /* ───────── 一括印刷の選択ダイアログ ───────── */
    function openBatchDialog(): void {
      if (cache.size === 0) {
        alert(
          'まだ印刷できる予約がありません。\n予約をいくつか開いてから一括印刷してください。',
        );
        return;
      }
      // 既存ダイアログがあれば閉じる
      document.getElementById(`${PREFIX}-dialog`)?.remove();

      const overlay = document.createElement('div');
      overlay.id = `${PREFIX}-dialog`;
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,.4)',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      } satisfies Partial<CSSStyleDeclaration>);

      const panel = document.createElement('div');
      Object.assign(panel.style, {
        background: '#fff',
        width: 'min(560px, 92vw)',
        maxHeight: '82vh',
        borderRadius: '10px',
        boxShadow: '0 8px 30px rgba(0,0,0,.35)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily:
          '"Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif',
        color: '#111',
      } satisfies Partial<CSSStyleDeclaration>);

      const header = document.createElement('div');
      header.textContent = '一括印刷 — 印刷する予約を選択';
      Object.assign(header.style, {
        padding: '14px 18px',
        fontSize: '15px',
        fontWeight: '700',
        borderBottom: '1px solid #eee',
      } satisfies Partial<CSSStyleDeclaration>);

      const list = document.createElement('div');
      Object.assign(list.style, {
        padding: '8px 18px',
        overflowY: 'auto',
        flex: '1',
      } satisfies Partial<CSSStyleDeclaration>);

      const checkboxes: HTMLInputElement[] = [];
      // 期間でソートして並べる（取得順だと分かりにくいため）
      const entries = Array.from(cache.entries()).map(([id, captured]) => ({
        id,
        karte: mapResponseToKarte(captured.data, mapOpts),
      }));
      entries.sort((a, b) =>
        (a.karte.period || '').localeCompare(b.karte.period || ''),
      );

      for (const { id, karte } of entries) {
        const row = document.createElement('label');
        Object.assign(row.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 4px',
          borderBottom: '1px solid #f2f2f2',
          cursor: 'pointer',
          fontSize: '13px',
        } satisfies Partial<CSSStyleDeclaration>);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.id = id;
        checkboxes.push(cb);

        const text = document.createElement('div');
        const title = document.createElement('div');
        title.textContent =
          `${karte.animalName || '(名称不明)'}` +
          `${karte.breed ? `（${karte.breed}）` : ''}` +
          `${karte.canceled ? ' ⚠キャンセル' : ''}`;
        title.style.fontWeight = '600';
        const sub = document.createElement('div');
        sub.textContent =
          `${karte.period || '期間不明'}　${karte.code ? `予約番号 ${karte.code}` : ''}`;
        Object.assign(sub.style, { color: '#666', fontSize: '11px' });
        text.append(title, sub);

        row.append(cb, text);
        list.appendChild(row);
      }

      const footer = document.createElement('div');
      Object.assign(footer.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 18px',
        borderTop: '1px solid #eee',
      } satisfies Partial<CSSStyleDeclaration>);

      const mkBtn = (label: string, primary = false): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        Object.assign(b.style, {
          padding: '8px 14px',
          fontSize: '13px',
          borderRadius: '6px',
          cursor: 'pointer',
          border: primary ? 'none' : '1px solid #ccc',
          background: primary ? '#2b7de9' : '#fff',
          color: primary ? '#fff' : '#333',
          fontWeight: primary ? '600' : '400',
        } satisfies Partial<CSSStyleDeclaration>);
        return b;
      };

      const selectAll = mkBtn('全選択');
      const deselectAll = mkBtn('全解除');
      const spacer = document.createElement('div');
      spacer.style.flex = '1';
      const cancelBtn = mkBtn('キャンセル');
      const printBtn = mkBtn('印刷', true);

      const updatePrintLabel = () => {
        const n = checkboxes.filter((c) => c.checked).length;
        printBtn.textContent = `印刷（${n}件）`;
        printBtn.disabled = n === 0;
        printBtn.style.opacity = n === 0 ? '0.5' : '1';
      };
      checkboxes.forEach((c) => c.addEventListener('change', updatePrintLabel));
      selectAll.addEventListener('click', () => {
        checkboxes.forEach((c) => (c.checked = true));
        updatePrintLabel();
      });
      deselectAll.addEventListener('click', () => {
        checkboxes.forEach((c) => (c.checked = false));
        updatePrintLabel();
      });

      const close = () => overlay.remove();
      cancelBtn.addEventListener('click', close);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      printBtn.addEventListener('click', () => {
        const ids = checkboxes.filter((c) => c.checked).map((c) => c.dataset.id!);
        close();
        printBatch(ids);
      });

      footer.append(selectAll, deselectAll, spacer, cancelBtn, printBtn);
      panel.append(header, list, footer);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      updatePrintLabel();
    }

    /* ───────── フローティングボタン群 ───────── */
    function ensureButtons(): void {
      if (document.getElementById(`${PREFIX}-fab`)) return;

      const container = document.createElement('div');
      container.id = `${PREFIX}-fab`;
      Object.assign(container.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483646',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        alignItems: 'flex-end',
      } satisfies Partial<CSSStyleDeclaration>);

      const style = (b: HTMLButtonElement, primary: boolean) =>
        Object.assign(b.style, {
          padding: primary ? '10px 16px' : '8px 14px',
          fontSize: primary ? '14px' : '13px',
          fontWeight: '600',
          color: primary ? '#fff' : '#2b7de9',
          background: primary ? '#2b7de9' : '#fff',
          border: primary ? 'none' : '1px solid #2b7de9',
          borderRadius: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,.25)',
          cursor: 'pointer',
        } satisfies Partial<CSSStyleDeclaration>);

      const batchBtn = document.createElement('button');
      batchBtn.id = `${PREFIX}-batch`;
      batchBtn.type = 'button';
      batchBtn.textContent = '🖨 一括印刷';
      batchBtn.title = '開いた予約からまとめて印刷します';
      style(batchBtn, false);
      batchBtn.addEventListener('click', openBatchDialog);

      const singleBtn = document.createElement('button');
      singleBtn.id = `${PREFIX}-single`;
      singleBtn.type = 'button';
      singleBtn.textContent = '🖨 印刷';
      singleBtn.title = 'この予約をご予約カルテ形式で印刷します';
      style(singleBtn, true);
      singleBtn.addEventListener('click', printSingle);

      container.append(batchBtn, singleBtn);
      document.body.appendChild(container);
      updateButtons();
    }

    function updateButtons(): void {
      const single = document.getElementById(
        `${PREFIX}-single`,
      ) as HTMLButtonElement | null;
      if (single) {
        const hasTarget = getTargetId() != null;
        single.disabled = !hasTarget;
        single.style.opacity = hasTarget ? '1' : '0.5';
        single.style.cursor = hasTarget ? 'pointer' : 'not-allowed';
      }
      const batch = document.getElementById(
        `${PREFIX}-batch`,
      ) as HTMLButtonElement | null;
      if (batch) {
        batch.textContent =
          cache.size > 0 ? `🖨 一括印刷 (${cache.size})` : '🖨 一括印刷';
        batch.disabled = cache.size === 0;
        batch.style.opacity = cache.size === 0 ? '0.5' : '1';
        batch.style.cursor = cache.size === 0 ? 'not-allowed' : 'pointer';
      }
    }

    /* ───────── ツールバー注入（ベストエフォート・要確認①） ───────── */
    function tryInjectToolbar(): void {
      if (document.getElementById(`${PREFIX}-tb`)) return;
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
      );
      const editBtn = candidates.find((el) => el.textContent?.trim() === '編集');
      if (!editBtn || !editBtn.parentElement) return;

      const tb = document.createElement('button');
      tb.id = `${PREFIX}-tb`;
      tb.type = 'button';
      tb.textContent = '🖨 印刷';
      tb.title = 'この予約をご予約カルテ形式で印刷します';
      Object.assign(tb.style, {
        marginLeft: '8px',
        padding: '4px 10px',
        fontSize: '13px',
        cursor: 'pointer',
      } satisfies Partial<CSSStyleDeclaration>);
      tb.addEventListener('click', printSingle);
      editBtn.parentElement.appendChild(tb);
    }

    /* ───────── 起動 ───────── */
    ensureButtons();
    tryInjectToolbar();

    const observer = new MutationObserver(() => {
      ensureButtons();
      tryInjectToolbar();
      updateButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
