import {
  isScheduleCapturedMessage,
  isScheduleListMessage,
  isTodayCountsMessage,
  isRangeCapturedMessage,
  isPrintIdsMessage,
  isFetchDoneMessage,
  type ScheduleCapturedMessage,
  type FetchRequestMessage,
  type TodayCountsRequestMessage,
  type GatherPrintRequestMessage,
  type CountGroup,
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
    /** 「全て印刷」の対象＝今表示している検索結果（単店舗）。 */
    let listIds: string[] = [];
    let latestId: string | null = null;

    const mapOpts = { staffNames: STAFF_NAMES };

    /** 「全て印刷」で再取得中の状態。null=非実行。received=今回取り直して届いたID。 */
    let pendingFetch: { wanted: string[]; received: Set<string> } | null = null;

    /** 店舗別件数グループ（本日／選択日）。null=未取得。 */
    let todayCounts: CountGroup[] | null = null;
    let countsTimer: number | null = null;
    let countsRetries = 0;
    let lastRangeKey = '';

    /** MAIN に店舗別件数を依頼（バースト/連続発火をデバウンスして最新の期間で1回） */
    function requestTodayCounts(): void {
      if (countsTimer != null) clearTimeout(countsTimer);
      countsTimer = window.setTimeout(() => {
        countsTimer = null;
        const req: TodayCountsRequestMessage = {
          source: KARTE_MESSAGE_SOURCE,
          type: 'today-counts-request',
        };
        window.postMessage(req, window.location.origin);
      }, 300);
    }

    /** 検索/カレンダーで URL(期間)が変わったら件数を取り直す */
    function maybeRequestCounts(): void {
      const mode = pageMode();
      if (mode !== 'search' && mode !== 'calendar') {
        lastRangeKey = '';
        return;
      }
      const key = window.location.pathname + window.location.search;
      if (key === lastRangeKey) return;
      lastRangeKey = key;
      countsRetries = 0;
      requestTodayCounts();
    }

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
        // 現在表示中の検索結果で置き換える（古い検索を引きずらない）＝印刷の対象
        listIds = data.ids.slice();
        updateButtons();
        return;
      }
      if (isRangeCapturedMessage(data)) {
        // 検索/カレンダーの表示期間が変わった → 店舗別件数を取り直す
        if (pageMode() === 'search' || pageMode() === 'calendar') {
          requestTodayCounts();
        }
        return;
      }
      if (isTodayCountsMessage(data)) {
        if (data.reason === 'no-token') {
          // トークン/会社ID がまだ揃っていない → 少し待って再試行
          if (countsRetries < 5) {
            countsRetries++;
            window.setTimeout(requestTodayCounts, 1200);
          }
          return;
        }
        countsRetries = 0;
        todayCounts = data.groups;
        renderTodayCounts();
        return;
      }
      if (isPrintIdsMessage(data)) {
        onPrintIdsGathered(data.ids, data.reason);
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

    /**
     * 「全て印刷」: 現在の絞り込みに関係なく、表示中の期間で全店舗の予約を集め、
     * カテゴリ＝ペットホテルのものだけを印刷する。
     * (1) MAIN に全店舗・期間のID収集を依頼 → (2) 詳細を取得 →
     * (3) category がホテルのものに絞って選択ダイアログ。
     */
    let gathering = false;

    function startPrintAll(): void {
      if (pendingFetch || gathering) return;
      gathering = true;
      showFetchProgress();
      setProgressText('印刷対象を集計中…（全店舗・ペットホテル）');
      const req: GatherPrintRequestMessage = {
        source: KARTE_MESSAGE_SOURCE,
        type: 'gather-print-request',
      };
      window.postMessage(req, window.location.origin);
      window.setTimeout(() => {
        if (gathering) {
          gathering = false;
          hideFetchProgress();
          alert('印刷対象の集計がタイムアウトしました。もう一度お試しください。');
        }
      }, 30_000);
    }

    /** MAIN から全店舗・期間のIDが返ってきた → 詳細取得を開始 */
    function onPrintIdsGathered(
      ids: string[],
      reason?: 'no-token' | 'no-range',
    ): void {
      if (!gathering) return;
      gathering = false;
      if (reason === 'no-token') {
        hideFetchProgress();
        alert(
          '認証情報を取得できませんでした。\n一覧を再読み込みしてから、もう一度お試しください。',
        );
        return;
      }
      if (reason === 'no-range') {
        hideFetchProgress();
        alert(
          '対象期間を取得できませんでした。\n予約の検索（その日など）を表示してから「ホテル予約印刷」を押してください。',
        );
        return;
      }
      if (ids.length === 0) {
        hideFetchProgress();
        alert('対象期間の予約が見つかりませんでした。');
        return;
      }
      pendingFetch = { wanted: ids, received: new Set() };
      updateFetchProgress();
      const req: FetchRequestMessage = {
        source: KARTE_MESSAGE_SOURCE,
        type: 'fetch-request',
        ids,
      };
      window.postMessage(req, window.location.origin);
      window.setTimeout(
        () => {
          if (pendingFetch) finishPrintAll(0);
        },
        Math.max(60_000, ids.length * 1_500),
      );
    }

    function finishPrintAll(errors: number, reason?: 'no-token'): void {
      if (!pendingFetch) return;
      const targetIds = pendingFetch.wanted.slice();
      const got = pendingFetch.received.size;
      pendingFetch = null;
      hideFetchProgress();
      if (reason === 'no-token') {
        alert(
          '予約データの再取得に必要な認証情報を取得できませんでした。\n一度どれか予約を開く／一覧を再読み込みしてから、もう一度お試しください。',
        );
        return;
      }
      if (got === 0 && errors > 0) {
        alert(
          '最新データの取得に失敗しました（認証の期限切れの可能性）。\n一覧を再読み込みしてから、もう一度お試しください。',
        );
        return;
      }
      if (errors > 0) {
        console.warn(`[cheriee-karte] 再取得に ${errors} 件失敗しました`);
      }
      // カテゴリ＝ペットホテル（マッピングで「ホテル」）のものだけに絞る
      const hotelIds = targetIds.filter((id) => {
        const c = cache.get(id);
        return !!c && mapResponseToKarte(c.data, mapOpts).category === 'ホテル';
      });
      if (hotelIds.length === 0) {
        alert('対象期間にペットホテルの予約が見つかりませんでした。');
        return;
      }
      openBatchDialog(hotelIds);
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

    function setProgressText(text: string): void {
      const box = document.getElementById(`${PREFIX}-progress-box`);
      if (box) box.textContent = text;
    }

    function updateFetchProgress(): void {
      if (!pendingFetch) return;
      const total = pendingFetch.wanted.length;
      const done = pendingFetch.received.size;
      setProgressText(`予約データを取得中… ${done} / ${total}`);
    }

    function hideFetchProgress(): void {
      document.getElementById(`${PREFIX}-progress`)?.remove();
    }

    /* ───────── 一括印刷の選択ダイアログ ─────────
     * 対象は「今回の検索結果」(targetIds)に限定する。cache 全体ではないので、
     * 検索を切り替えても前回ぶんが混ざらない。 */
    function openBatchDialog(targetIds: string[] = allTargetIds()): void {
      // 今回の対象のうち、データが取得できているものだけ表示
      const ids = targetIds.filter((id) => cache.has(id));
      if (ids.length === 0) {
        alert(
          '印刷できる予約データがありません。\n一覧を再読み込みしてから、もう一度お試しください。',
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
      header.textContent = `ホテル予約印刷 — ${ids.length}件から選択`;
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
      // 今回の対象IDのみ（cache 全体ではない）。期間でソートして並べる。
      const entries = ids
        .map((id) => {
          const captured = cache.get(id)!;
          return { id, karte: mapResponseToKarte(captured.data, mapOpts) };
        })
        .sort((a, b) =>
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
        const owner = karte.contact.name || '(飼い主名不明)';
        title.textContent =
          `${owner}` +
          `${karte.animalName ? `　／　${karte.animalName}` : ''}` +
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
      batchBtn.textContent = '🖨 ホテル予約印刷';
      batchBtn.title = '一覧の全予約をまとめて印刷します（未取得分は自動取得）';
      style(batchBtn, false);
      batchBtn.addEventListener('click', startPrintAll);

      const singleBtn = document.createElement('button');
      singleBtn.id = `${PREFIX}-single`;
      singleBtn.type = 'button';
      singleBtn.textContent = '🖨 カルテ印刷';
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
        // 全店舗・ペットホテルで印刷するため、検索結果の件数は出さない
        batch.textContent = '🖨 ホテル予約印刷';
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

    /**
     * 現在ページの種別。
     *  - 'search'  : /schedules/search → 「全て印刷」＋店舗別件数
     *  - 'calendar': /schedules/calendar/... → 店舗別件数のみ（印刷ボタンなし）
     *  - 'detail'  : /schedules/{数値id} → 「印刷」(単票)
     *  - 'other'   : それ以外 → 何も出さない
     */
    function pageMode(): 'search' | 'calendar' | 'detail' | 'other' {
      const p = window.location.pathname;
      if (/\/schedules\/search(?:[/?#]|$)/.test(p)) return 'search';
      if (/\/schedules\/calendar(?:[/?#]|$)/.test(p)) return 'calendar';
      if (/\/schedules\/\d+(?:[/?#]|$)/.test(p)) return 'detail';
      return 'other';
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

    /**
     * 店舗別＋合計の予約数を見出し付近に表示する。
     *  - 検索ページ: 「○件ヒットしました」の横にインライン表示。
     *  - カレンダー: 見出し直下にブロック表示。
     * 対象外ページ・未取得なら撤去。
     */
    function renderTodayCounts(): void {
      const existing = document.getElementById(`${PREFIX}-counts`);
      const mode = pageMode();
      if ((mode !== 'search' && mode !== 'calendar') || !todayCounts) {
        existing?.remove();
        return;
      }
      const heading = document.querySelector('app-page-heading');
      if (!heading) return;

      // 字幕（検索:「○件ヒット」/ カレンダー:「○件の予約があります。…表示します。」）の
      // リーフを探し、その親（字幕行）の末尾にぶら下げる＝字幕の横に出る。
      const leaf = Array.from(heading.querySelectorAll<HTMLElement>('div')).find(
        (d) =>
          d.children.length === 0 &&
          /ヒットしました|件の予約|カレンダーに表示|表示します/.test(
            d.textContent ?? '',
          ),
      );
      const inline = !!leaf?.parentElement;
      const container = leaf?.parentElement ?? heading;

      let el = document.getElementById(`${PREFIX}-counts`);
      if (!el || el.parentElement !== container) {
        el?.remove();
        el = document.createElement('span');
        el.id = `${PREFIX}-counts`;
        Object.assign(
          el.style,
          inline
            ? { marginLeft: '8px', fontWeight: '700' }
            : {
                display: 'block',
                marginTop: '4px',
                fontSize: '13px',
                fontWeight: '700',
              },
        );
        container.appendChild(el);
      }

      // グループ（本日／選択日）ごとに色分け。内容が同じなら作り直さない。
      const sig = JSON.stringify(todayCounts);
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      el.textContent = '';

      const GROUP_COLORS = ['#2b7de9', '#e8730c']; // 本日=青 / 選択日=橙
      const STORE_COLOR = '#374151'; // 店舗名・件数は濃いグレー
      todayCounts.forEach((g, gi) => {
        const color = GROUP_COLORS[gi % GROUP_COLORS.length]!;
        const groupSpan = document.createElement('span');
        groupSpan.style.marginLeft = gi === 0 ? '0' : '14px';

        const label = document.createElement('b');
        label.textContent = `｜${g.label}の予約`;
        label.style.color = color;
        groupSpan.appendChild(label);

        for (const r of g.results) {
          const part = document.createElement('span');
          part.textContent = `　${r.name}: ${r.count ?? '—'}件`;
          part.style.color = STORE_COLOR;
          part.style.fontWeight = '600';
          groupSpan.appendChild(part);
        }

        const total = g.results.reduce((s, r) => s + (r.count ?? 0), 0);
        const tot = document.createElement('b');
        tot.textContent = `　合計: ${total}件`;
        tot.style.color = color;
        groupSpan.appendChild(tot);

        el!.appendChild(groupSpan);
      });
    }

    /** ツールバーへ注入した種別（フローティング表示判断に使う） */
    interface ToolbarState {
      all: boolean;
      single: boolean;
    }

    function tryInjectToolbar(): ToolbarState {
      const mode = pageMode();
      // 出すべきボタンの種別（search→all / detail→single / other→なし）
      const wantCtx: 'all' | 'single' | null =
        mode === 'search' ? 'all' : mode === 'detail' ? 'single' : null;

      const row = findHeadingRow();
      if (!row) return { all: false, single: false };

      const existing = row.querySelector<HTMLElement>(`.${TB_MARK}`);
      // 種別が変わった/不要になったら撤去（SPA遷移でページ種別が変わるため）
      if (existing && existing.dataset.ctx !== wantCtx) existing.remove();

      if (wantCtx && !row.querySelector(`.${TB_MARK}`)) {
        const el =
          wantCtx === 'all'
            ? makeNativeButton('ホテル予約印刷', 'fa-print', startPrintAll)
            : makeNativeButton('カルテ印刷', 'fa-print', printSingle);
        el.dataset.ctx = wantCtx;
        row.appendChild(el);
        console.info('[cheriee-karte] ツールバーに印刷ボタンを注入しました', wantCtx);
      }

      const cur = row.querySelector<HTMLElement>(`.${TB_MARK}`);
      return {
        all: cur?.dataset.ctx === 'all',
        single: cur?.dataset.ctx === 'single',
      };
    }

    /**
     * フローティングはフォールバック。ページ種別に合うボタンだけ、かつ
     * ツールバーに出せなかった時のみ表示する（全て印刷は search のみ）。
     */
    function syncFloating(injected: ToolbarState): void {
      const mode = pageMode();
      const batch = document.getElementById(`${PREFIX}-batch`);
      const single = document.getElementById(`${PREFIX}-single`);
      if (batch) {
        batch.style.display =
          mode === 'search' && !injected.all ? '' : 'none';
      }
      if (single) {
        single.style.display =
          mode === 'detail' && !injected.single ? '' : 'none';
      }
      const fab = document.getElementById(`${PREFIX}-fab`);
      if (fab) {
        const anyVisible =
          (batch && batch.style.display !== 'none') ||
          (single && single.style.display !== 'none');
        fab.style.display = anyVisible ? 'flex' : 'none';
      }
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
    // 自分が挿入した要素（カウント表示・フローティング・ダイアログ）内の変化は無視。
    const ownSelector = `#${PREFIX}-fab, #${PREFIX}-dialog, #${PREFIX}-progress, #${PREFIX}-counts`;

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
        syncFloating(injected);
        maybeRequestCounts(); // URL(期間)が変わっていれば件数を取り直す
        renderTodayCounts();
      });
    }

    ensureButtons();
    syncFloating(tryInjectToolbar());

    const observer = new MutationObserver((records) => {
      // すべて自分のUI内の変化なら無視（自己ループ防止）
      if (records.every(isOwnMutation)) return;
      scheduleSync();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
