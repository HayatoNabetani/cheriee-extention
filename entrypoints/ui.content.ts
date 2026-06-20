import {
  isScheduleCapturedMessage,
  isScheduleListMessage,
  isFetchDoneMessage,
  type ScheduleCapturedMessage,
  type FetchRequestMessage,
  KARTE_MESSAGE_SOURCE,
} from '@/lib/types';
import { mapResponseToKarte, type Karte } from '@/lib/mapResponseToKarte';
import { renderKarte, renderKartes } from '@/lib/renderKarte';

/**
 * ISOLATEDワールド。interceptor(MAIN) が横取りしたレスポンスを受信してキャッシュし、
 * 予約に「🖨 印刷」「🖨 全て印刷」ボタンを出す。
 *
 * - 単票印刷: 現在開いている予約をカルテ印刷。
 * - 全て印刷: 一覧APIで把握した全予約を、未取得分は保存済みトークンで自動再取得して
 *   から、全件チェック済みの選択ダイアログ経由でまとめて印刷。
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

    // 読み込み確認用（実機での切り分け）。problemなら DevTools コンソールに出る。
    console.info('[cheriee-karte] content script loaded');

    /** scheduleId → 捕捉メッセージ（詳細データ）。 */
    const cache = new Map<string, ScheduleCapturedMessage>();
    /**
     * 「今表示している一覧」の予約ID。一覧APIを横取りするたびに置き換える
     * （accumulate しない）。これにより「全て印刷」の件数が現在の検索結果と一致する。
     */
    let listIds: string[] = [];
    let latestId: string | null = null;

    const mapOpts = { staffNames: STAFF_NAMES };

    /** 「全て印刷」で再取得中の状態。null=非実行。received=今回取り直して届いたID。 */
    let pendingFetch: { wanted: string[]; received: Set<string> } | null = null;

    /* ───────── 捕捉データ受信 ───────── */
    window.addEventListener('message', (event) => {
      if (event.source !== window) return; // 同一ウィンドウのみ
      if (event.origin !== window.location.origin) return;
      const data = event.data;

      if (isScheduleCapturedMessage(data)) {
        cache.set(data.scheduleId, data); // 最新で上書き（変更が反映される）
        latestId = data.scheduleId;
        if (pendingFetch && pendingFetch.wanted.includes(data.scheduleId)) {
          pendingFetch.received.add(data.scheduleId);
          updateFetchProgress();
        }
        updateButtons();
        return;
      }
      if (isScheduleListMessage(data)) {
        // 現在表示中の一覧で置き換える（古い検索結果を引きずらない）
        listIds = data.ids.slice();
        updateButtons();
        return;
      }
      if (isFetchDoneMessage(data)) {
        finishPrintAll(data.errors, data.reason);
        return;
      }
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

    /* ───────── 「全て印刷」: 一覧の全予約を対象に ─────────
     * 一覧で把握した全ID＋開いた予約をまとめて対象とし、未取得分は MAIN に
     * 再取得を依頼。揃ったら全件チェック済みの選択ダイアログを開く。 */
    function allTargetIds(): string[] {
      // 一覧を捕捉していればそれ（＝現在の検索結果）を対象に。
      // まだ一覧が無ければ、開いた予約（キャッシュ）を対象にフォールバック。
      return listIds.length > 0 ? listIds.slice() : Array.from(cache.keys());
    }

    function startPrintAll(): void {
      if (pendingFetch) return; // 取得中は無視
      const ids = allTargetIds();
      if (ids.length === 0) {
        alert(
          '印刷対象の予約が見つかりません。\n予約一覧（その日の予約など）を表示してから「全て印刷」を押してください。',
        );
        return;
      }
      // カテゴリ・時間・備考などの変更を反映するため、対象を全件 最新に取り直す。
      // （取得できなかった分は、既にキャッシュ済みの内容があればそれで代替する）
      pendingFetch = { wanted: ids, received: new Set() };
      showFetchProgress();
      const req: FetchRequestMessage = {
        source: KARTE_MESSAGE_SOURCE,
        type: 'fetch-request',
        ids,
      };
      window.postMessage(req, window.location.origin);
      // 念のためのタイムアウト（MAINから fetch-done が来ない場合）。件数に応じて延長。
      window.setTimeout(
        () => {
          if (pendingFetch) finishPrintAll(0);
        },
        Math.max(60_000, ids.length * 1_500),
      );
    }

    function finishPrintAll(errors: number, reason?: 'no-token'): void {
      if (!pendingFetch) return;
      const total = pendingFetch.wanted.length;
      const got = pendingFetch.received.size;
      pendingFetch = null;
      hideFetchProgress();
      if (reason === 'no-token') {
        alert(
          '予約データの再取得に必要な認証情報を取得できませんでした。\n一度どれか予約を開く／一覧を再読み込みしてから、もう一度お試しください。',
        );
      } else if (got === 0 && errors > 0) {
        // 全件取得失敗（トークン期限切れ等の可能性）。キャッシュがあればそれで続行。
        alert(
          '最新データの取得に失敗しました（認証の期限切れの可能性）。\n一覧を再読み込みしてから、もう一度お試しください。\n（取得済みのデータがあればそのまま表示します）',
        );
      } else if (errors > 0) {
        // 一部のみ失敗。届いた分は最新、残りはキャッシュ（あれば）で続行。
        console.warn(`[cheriee-karte] 再取得に ${errors} 件失敗しました`);
      }
      openBatchDialog();
    }

    /* 取得中の進捗オーバーレイ */
    function showFetchProgress(): void {
      document.getElementById(`${PREFIX}-progress`)?.remove();
      const overlay = document.createElement('div');
      overlay.id = `${PREFIX}-progress`;
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,.4)',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      } satisfies Partial<CSSStyleDeclaration>);
      const box = document.createElement('div');
      box.id = `${PREFIX}-progress-box`;
      Object.assign(box.style, {
        background: '#fff',
        padding: '20px 28px',
        borderRadius: '10px',
        boxShadow: '0 8px 30px rgba(0,0,0,.35)',
        fontFamily:
          '"Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif',
        fontSize: '14px',
        color: '#111',
      } satisfies Partial<CSSStyleDeclaration>);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      updateFetchProgress();
    }

    function updateFetchProgress(): void {
      const box = document.getElementById(`${PREFIX}-progress-box`);
      if (!box || !pendingFetch) return;
      const total = pendingFetch.wanted.length;
      const done = pendingFetch.received.size;
      box.textContent = `予約データを最新に取得中… ${done} / ${total}`;
    }

    function hideFetchProgress(): void {
      document.getElementById(`${PREFIX}-progress`)?.remove();
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
      batchBtn.textContent = '🖨 全て印刷';
      batchBtn.title = '一覧の全予約をまとめて印刷します（未取得分は自動取得）';
      style(batchBtn, false);
      batchBtn.addEventListener('click', startPrintAll);

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
        const n = allTargetIds().length;
        batch.textContent = n > 0 ? `🖨 全て印刷 (${n})` : '🖨 全て印刷';
        batch.disabled = n === 0;
        batch.style.opacity = n === 0 ? '0.5' : '1';
        batch.style.cursor = n === 0 ? 'not-allowed' : 'pointer';
      }
    }

    /* ───────── ツールバー注入（ネイティブ風） ─────────
     * cheriee のページ見出しツールバー（新規予約／ダウンロード／編集 等の行）に、
     * 同じマークアップ・クラスの「印刷」ボタンを並べる。
     *   - 一覧/検索ツールバー（新規予約・ダウンロード） → 「全て印刷」
     *   - 詳細ツールバー（編集 等）                     → 「印刷」（単票）
     * FontAwesome は cheriee が読み込み済みのため fa-regular fa-print を使用。 */
    const TB_MARK = `${PREFIX}-tb`;

    function makeNativeButton(
      label: string,
      faIcon: string,
      onClick: () => void,
    ): HTMLElement {
      const wrap = document.createElement('app-action-button');
      wrap.className = `ng-star-inserted ${TB_MARK}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      // ネイティブ（新規予約/ダウンロード）と同一クラス
      btn.className =
        'mat-mdc-tooltip-trigger flex flex-row items-center justify-center ' +
        'gap-1 font-medium duration-300 whitespace-nowrap outline-0 ' +
        'bg-transparent border border-transparent hover:bg-gray-900 ' +
        'hover:bg-opacity-5 min-w-20 px-1 py-2 rounded sm:min-w-24 ' +
        'text-gray-900 text-sm tracking-tight';

      const icon = document.createElement('app-icon');
      icon.setAttribute('type', 'regular');
      icon.className = 'hidden sm:inline-block';
      const i = document.createElement('i');
      i.className = `inline-block fa-regular ${faIcon}`;
      i.setAttribute('aria-hidden', 'true');
      icon.appendChild(i);

      btn.append(icon, document.createTextNode(label));
      btn.addEventListener('click', onClick);
      wrap.appendChild(btn);
      return wrap;
    }

    /** いま詳細ページか（URLに数値scheduleId）。それ以外は一覧扱い。 */
    function isDetailContext(): boolean {
      return /\/schedules\/\d+(?:[/?#]|$)/.test(window.location.pathname);
    }

    /**
     * 見出しツールバー行（新規予約／ダウンロード／編集 等が並ぶ div）を探す。
     * テキストに依存せず、app-page-heading 内の app-action-button の親を使う。
     * 見つからなければラベル一致でフォールバック。
     */
    function findHeadingRow(): HTMLElement | null {
      const heading = document.querySelector('app-page-heading');
      const anchor = heading?.querySelector('app-action-button');
      if (anchor?.parentElement) return anchor.parentElement;

      // フォールバック: 既知ラベルを持つ action-button の親
      const btns = Array.from(
        document.querySelectorAll<HTMLButtonElement>('app-action-button button'),
      );
      const labels = ['新規予約', 'ダウンロード', '編集', '会計', '記録'];
      for (const b of btns) {
        const t = b.textContent?.trim();
        if (t && labels.includes(t)) {
          const wrap = b.closest('app-action-button');
          if (wrap?.parentElement) return wrap.parentElement;
        }
      }
      return null;
    }

    /** ツールバーへ注入できたら true（フローティング非表示の判断に使う） */
    function tryInjectToolbar(): boolean {
      const row = findHeadingRow();
      if (!row) return false;

      const ctx = isDetailContext() ? 'detail' : 'list';
      const existing = row.querySelector<HTMLElement>(`.${TB_MARK}`);
      // 文脈が変わったら作り直す（一覧↔詳細でラベル/動作が変わる）
      if (existing && existing.dataset.ctx !== ctx) existing.remove();

      if (!row.querySelector(`.${TB_MARK}`)) {
        const el =
          ctx === 'detail'
            ? makeNativeButton('印刷', 'fa-print', printSingle)
            : makeNativeButton('全て印刷', 'fa-print', startPrintAll);
        el.dataset.ctx = ctx;
        row.appendChild(el);
        if (!toolbarLogged) {
          console.info('[cheriee-karte] ツールバーに印刷ボタンを注入しました', ctx);
          toolbarLogged = true;
        }
      }
      return true;
    }
    let toolbarLogged = false;

    /** ツールバー注入できた場合はフローティングを隠す（重複回避） */
    function syncFloatingVisibility(toolbarInjected: boolean): void {
      const fab = document.getElementById(`${PREFIX}-fab`);
      if (fab) fab.style.display = toolbarInjected ? 'none' : 'flex';
    }

    /* ───────── 起動 ─────────
     * SPA の再描画でボタンが消えても復活させ、詳細パネルが開いたらツールバー注入。
     *
     * 注意: observer の中で DOM を書き換える（updateButtons の textContent 等）と、
     * その変更自体が再び observer を発火させ無限ループ→ページが固まる。
     * これを防ぐため:
     *   1) 自分のUI内だけの変化は無視する（自己発火カット）
     *   2) rAF でデバウンスし、1フレーム1回に集約する
     */
    const ownSelector = `#${PREFIX}-fab, #${PREFIX}-dialog`;

    function isOwnMutation(record: MutationRecord): boolean {
      const t = record.target;
      const el = t instanceof Element ? t : t.parentElement;
      return !!el && !!el.closest(ownSelector);
    }

    let syncScheduled = false;
    function scheduleSync(): void {
      if (syncScheduled) return;
      syncScheduled = true;
      requestAnimationFrame(() => {
        syncScheduled = false;
        ensureButtons();
        const injected = tryInjectToolbar();
        updateButtons();
        syncFloatingVisibility(injected);
      });
    }

    ensureButtons();
    syncFloatingVisibility(tryInjectToolbar());

    const observer = new MutationObserver((records) => {
      // すべて自分のUI内の変化なら無視（自己ループ防止）
      if (records.every(isOwnMutation)) return;
      scheduleSync();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
