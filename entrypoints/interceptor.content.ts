import {
  KARTE_MESSAGE_SOURCE,
  isFetchRequestMessage,
  isTodayCountsRequestMessage,
  type ScheduleCapturedMessage,
  type ScheduleListMessage,
  type FetchDoneMessage,
  type CherieeScheduleResponse,
} from '@/lib/types';

/**
 * MAINワールド。ページの fetch / XMLHttpRequest をラップし、
 * シェリーAPIのレスポンスを横取りして window.postMessage で ISOLATED 側へ渡す。
 *
 *  - 詳細: `GET /v2/companies/{companyId}/schedules/{数値id}` → 'schedule-response'
 *  - 一覧: `GET /v2/companies/{companyId}/schedules?...`      → 'schedule-list'（ID群）
 *
 * さらに、ISOLATED からの 'fetch-request' を受けて、横取りで控えた Bearer トークンと
 * companyId を使い詳細APIを再取得する（「全て印刷」用）。ページ自身のオリジンからの
 * fetch なので追加の host 権限は不要。トークン/PII は外部送信・永続化しない。
 */
export default defineContentScript({
  matches: ['https://cheriee.biz/*'],
  // ページ自身の fetch/XHR より前にパッチを当てるため document_start。
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const ORIGIN = window.location.origin;
    // /v2/companies/{companyId}/schedules/{数値id}
    const SCHEDULE_RE = /\/v2\/companies\/([^/]+)\/schedules\/(\d+)(?:[/?#]|$)/;
    // 一覧は「予約の検索」結果のみ採用する。
    // 汎用 /schedules（カレンダー/日次ビュー等の全カテゴリ一覧）を拾うと、
    // 画面の絞り込み結果と件数がズレるため /schedules/search に限定。
    const LIST_RE = /\/v2\/companies\/([^/]+)\/schedules\/search(?:[/?#]|$)/;
    // カレンダー（月/週/日ビュー）。期間は start/end クエリで持つ。
    const CALENDAR_RE = /\/v2\/companies\/([^/]+)\/schedules\/calendar\//;

    // 再取得に使うため、直近に見た会社IDとトークンを保持（メモリのみ）。
    let lastCompanyId: string | undefined;
    let lastAuth: string | undefined;

    // 全店舗まとめ検索のため、検索ボディ（日付・条件）と全店舗IDを保持。
    let lastSearchBody: Record<string, unknown> | null = null;
    const tenantIds = new Set<string>();

    function rememberCreds(companyId?: string, auth?: string): void {
      if (companyId) lastCompanyId = companyId;
      if (auth) lastAuth = auth;
    }

    /** 検索リクエストのボディ（POST JSON）を控える。tenantId も収集。 */
    function postRangeCaptured(): void {
      window.postMessage(
        { source: KARTE_MESSAGE_SOURCE, type: 'range-captured' },
        ORIGIN,
      );
    }

    function captureSearchBody(rawBody: unknown): void {
      if (typeof rawBody !== 'string') return;
      try {
        const obj = JSON.parse(rawBody) as Record<string, unknown>;
        lastSearchBody = obj;
        if (typeof obj.tenantId === 'string') tenantIds.add(obj.tenantId);
        postRangeCaptured();
      } catch {
        /* JSONでなければ無視 */
      }
    }

    /** カレンダー(月/週/日)リクエストの URL から表示中の期間を控える */
    function captureCalendar(url: string | undefined): boolean {
      if (!url) return false;
      const m = CALENDAR_RE.exec(url);
      if (!m) return false;
      rememberCreds(m[1], undefined);
      try {
        const u = new URL(url, ORIGIN);
        const start = u.searchParams.get('start');
        const end = u.searchParams.get('end');
        const tenantId = u.searchParams.get('tenantId');
        if (start && end) {
          lastSearchBody = { start, end, ...(tenantId ? { tenantId } : {}) };
          if (tenantId) tenantIds.add(tenantId);
          console.info(`[cheriee-karte] calendar range: ${start}..${end}`);
          postRangeCaptured();
        }
      } catch {
        /* URLでなければ無視 */
      }
      return true;
    }

    /** 店舗一覧（URLに tenant を含む）レスポンスから tenantId を収集。 */
    function captureTenants(url: string, data: unknown): void {
      let arr: unknown[] | null = null;
      if (Array.isArray(data)) arr = data;
      else if (data && typeof data === 'object') {
        for (const key of ['data', 'tenants', 'items', 'results', 'rows', 'list']) {
          const v = (data as Record<string, unknown>)[key];
          if (Array.isArray(v)) {
            arr = v;
            break;
          }
        }
      }
      if (!arr) return;
      let added = 0;
      for (const t of arr) {
        if (t && typeof t === 'object') {
          const id = (t as Record<string, unknown>).id;
          if (typeof id === 'string' && !tenantIds.has(id)) {
            tenantIds.add(id);
            added++;
          }
        }
      }
      if (added > 0) {
        console.info(
          `[cheriee-karte] tenants captured: ${url} → 全${tenantIds.size}店舗`,
        );
      }
    }

    function emit(
      scheduleId: string,
      data: CherieeScheduleResponse,
      url?: string,
      auth?: string,
    ): void {
      const msg: ScheduleCapturedMessage = {
        source: KARTE_MESSAGE_SOURCE,
        type: 'schedule-response',
        scheduleId,
        data,
        url,
        auth,
      };
      window.postMessage(msg, ORIGIN);
    }

    function emitList(ids: string[]): void {
      if (ids.length === 0) return;
      const msg: ScheduleListMessage = {
        source: KARTE_MESSAGE_SOURCE,
        type: 'schedule-list',
        ids,
      };
      window.postMessage(msg, ORIGIN);
    }

    function detailMatch(url: string | undefined): {
      companyId: string;
      id: string;
    } | null {
      if (!url) return null;
      const m = SCHEDULE_RE.exec(url);
      return m && m[1] && m[2] ? { companyId: m[1], id: m[2] } : null;
    }

    function listMatch(url: string | undefined): string | null {
      if (!url) return null;
      // 詳細(/{id})は除外
      if (SCHEDULE_RE.test(url)) return null;
      const m = LIST_RE.exec(url);
      return m && m[1] ? m[1] : null;
    }

    /** 一覧レスポンス本体から予約ID配列を抽出（配列 or {data/schedules/items/...:[]}） */
    function extractListIds(data: unknown): string[] {
      let arr: unknown[] | null = null;
      if (Array.isArray(data)) {
        arr = data;
      } else if (data && typeof data === 'object') {
        for (const key of ['data', 'schedules', 'items', 'results', 'rows', 'list']) {
          const v = (data as Record<string, unknown>)[key];
          if (Array.isArray(v)) {
            arr = v;
            break;
          }
        }
      }
      if (!arr) return [];
      const ids: string[] = [];
      for (const item of arr) {
        if (item && typeof item === 'object') {
          const id = (item as Record<string, unknown>).id;
          if (typeof id === 'number') ids.push(String(id));
          else if (typeof id === 'string' && /^\d+$/.test(id)) ids.push(id);
        }
      }
      return ids;
    }

    /** 横取りした生テキスト/JSONを詳細 / 一覧 / 店舗一覧 として処理 */
    function handleBody(url: string | undefined, parse: () => unknown): void {
      // 店舗一覧（URLに tenant を含む）→ tenantId 収集
      if (url && /tenant/i.test(url) && !LIST_RE.test(url) && !SCHEDULE_RE.test(url)) {
        try {
          captureTenants(url, parse());
        } catch {
          /* 店舗一覧でなければ無視 */
        }
        return;
      }
      const detail = detailMatch(url);
      if (detail) {
        rememberCreds(detail.companyId, undefined);
        try {
          const data = parse() as CherieeScheduleResponse;
          if (data) emit(detail.id, data, url, lastAuth);
        } catch {
          /* JSONでない/解析失敗は無視 */
        }
        return;
      }
      const listCompany = listMatch(url);
      if (listCompany) {
        rememberCreds(listCompany, undefined);
        try {
          const ids = extractListIds(parse());
          // 切り分け用ログ: どのURLが何件返しているか（5件 vs 12件 の特定に使う）
          console.info(
            `[cheriee-karte] list captured (${ids.length}件): ${url}`,
          );
          emitList(ids);
        } catch {
          /* 一覧でない/解析失敗は無視 */
        }
      }
    }

    function authFromHeaders(
      headers: HeadersInit | undefined,
    ): string | undefined {
      if (!headers) return undefined;
      try {
        if (headers instanceof Headers) {
          return headers.get('authorization') ?? undefined;
        }
        if (Array.isArray(headers)) {
          const hit = headers.find(([k]) => k.toLowerCase() === 'authorization');
          return hit?.[1];
        }
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === 'authorization') return String(v);
        }
      } catch {
        /* noop */
      }
      return undefined;
    }

    /* ───────── fetch パッチ ───────── */
    const origFetch = window.fetch;
    window.fetch = function (
      this: typeof window,
      ...args: Parameters<typeof fetch>
    ): Promise<Response> {
      const [input, init] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : String(input);

      const promise = origFetch.apply(this, args);

      const inspect =
        !!detailMatch(url) || !!listMatch(url) || /tenant/i.test(url);
      if (listMatch(url) && typeof init?.body === 'string') {
        captureSearchBody(init.body); // 検索条件（日付等）を控える
      }
      captureCalendar(url); // カレンダー表示中の期間を控える
      if (inspect) {
        const auth =
          authFromHeaders(init?.headers) ??
          (input instanceof Request
            ? input.headers.get('authorization') ?? undefined
            : undefined);
        rememberCreds(undefined, auth);
        promise
          .then((res) => {
            res
              .clone()
              .text()
              .then((text) => handleBody(url, () => JSON.parse(text)))
              .catch(() => {
                /* 本文読めず無視 */
              });
          })
          .catch(() => {
            /* fetch自体の失敗は無視 */
          });
      }
      return promise;
    } as typeof window.fetch;

    /* ───────── XMLHttpRequest パッチ ───────── */
    interface PatchedXHR extends XMLHttpRequest {
      __cheriee_url?: string;
      __cheriee_auth?: string;
    }

    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSetHeader = proto.setRequestHeader;

    proto.open = function (
      this: PatchedXHR,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__cheriee_url = typeof url === 'string' ? url : url.href;
      // @ts-expect-error 可変長を原関数へ素通し
      return origOpen.call(this, method, url, ...rest);
    };

    proto.setRequestHeader = function (
      this: PatchedXHR,
      name: string,
      value: string,
    ) {
      if (name.toLowerCase() === 'authorization') {
        this.__cheriee_auth = value;
        rememberCreds(undefined, value);
      }
      return origSetHeader.call(this, name, value);
    };

    proto.send = function (this: PatchedXHR, ...args: unknown[]) {
      const url = this.__cheriee_url;
      if (listMatch(url) && typeof args[0] === 'string') {
        captureSearchBody(args[0]); // 検索条件（日付等）を控える
      }
      captureCalendar(url); // カレンダー表示中の期間を控える
      const inspect =
        !!detailMatch(url) || !!listMatch(url) || (!!url && /tenant/i.test(url));
      if (inspect) {
        this.addEventListener('load', () => {
          rememberCreds(undefined, this.__cheriee_auth);
          const rt = this.responseType;
          if (rt === '' || rt === 'text') {
            handleBody(url, () => JSON.parse(this.responseText));
          } else if (rt === 'json') {
            handleBody(url, () => this.response);
          }
        });
      }
      // @ts-expect-error 可変長を原関数へ素通し
      return origSend.apply(this, args);
    };

    /* ───────── 詳細の再取得（「全て印刷」用） ─────────
     * ISOLATED からの依頼を受け、控えたトークン/companyId で詳細APIを叩く。
     * 取得結果は通常の 'schedule-response' として流す（ui側でキャッシュされる）。 */
    function postDone(ids: string[], errors: number, reason?: 'no-token'): void {
      const msg: FetchDoneMessage = {
        source: KARTE_MESSAGE_SOURCE,
        type: 'fetch-done',
        ids,
        errors,
        reason,
      };
      window.postMessage(msg, ORIGIN);
    }

    async function refetch(ids: string[]): Promise<void> {
      const companyId = lastCompanyId;
      const token = lastAuth;
      if (!companyId || !token) {
        postDone(ids, ids.length, 'no-token');
        return;
      }
      let errors = 0;
      const queue = ids.slice();
      const worker = async (): Promise<void> => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          try {
            const res = await origFetch(
              `https://api.cheriee.jp/v2/companies/${companyId}/schedules/${id}`,
              { headers: { Authorization: token, 'Accept-Language': 'ja' } },
            );
            if (!res.ok) {
              errors++;
              continue;
            }
            const data = (await res.json()) as CherieeScheduleResponse;
            emit(id, data, res.url, token);
          } catch {
            errors++;
          }
        }
      };
      // 同時実行は控えめに（最大5並列）
      const n = Math.min(5, Math.max(1, ids.length));
      await Promise.all(Array.from({ length: n }, () => worker()));
      postDone(ids, errors);
    }

    /* ───────── 本日の店舗別予約数 ─────────
     * 各店舗(tenantId)について「本日(JST 00:00〜23:59:59)」で /schedules/search を
     * 叩き、件数を数える。origFetch を使うのでパッチに再捕捉されずループしない。
     *
     * 店舗(tenantId と表示名)はこの店舗構成に合わせた固定リスト。店舗が増減・改名
     * したらここを編集する。 */
    const TENANTS: { id: string; name: string }[] = [
      { id: '703ac958-9334-4432-9efa-81aa06768414', name: '二子玉川' },
      { id: 'e1ac2ad2-9c78-4bf8-a2a0-6579878fd8e5', name: 'ドッグカレッジ' },
    ];

    /** 本日(JST)の 00:00:00〜23:59:59 を +09:00 付きISO文字列で返す */
    function todayRangeJst(): { start: string; end: string } {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      const date = `${get('year')}-${get('month')}-${get('day')}`;
      return {
        start: `${date}T00:00:00+09:00`,
        end: `${date}T23:59:59+09:00`,
      };
    }

    type TenantCount = { name: string; count: number | null };
    type CountGroup = { label: string; results: TenantCount[] };

    function postCounts(groups: CountGroup[], reason?: 'no-token'): void {
      window.postMessage(
        { source: KARTE_MESSAGE_SOURCE, type: 'today-counts', groups, reason },
        ORIGIN,
      );
    }

    /** 指定期間で全店舗の件数を数える */
    async function queryCounts(
      companyId: string,
      token: string,
      start: string,
      end: string,
    ): Promise<TenantCount[]> {
      const results: TenantCount[] = [];
      for (const t of TENANTS) {
        try {
          const body = JSON.stringify({
            tenantId: t.id,
            page: 1,
            size: 500,
            sort: 'CREATED',
            start,
            end,
          });
          const res = await origFetch(
            `https://api.cheriee.jp/v2/companies/${companyId}/schedules/search`,
            {
              method: 'POST',
              headers: {
                Authorization: token,
                'Accept-Language': 'ja',
                'Content-Type': 'application/json',
              },
              body,
            },
          );
          results.push({
            name: t.name,
            count: res.ok ? extractListIds(await res.json()).length : null,
          });
        } catch {
          results.push({ name: t.name, count: null });
        }
      }
      return results;
    }

    /** ISO(...+09:00) の日付部分(YYYY-MM-DD) */
    const isoDate = (s: string) => s.slice(0, 10);

    /** 選択期間のラベル（例 "6/23(火)" / "6月" / "6/23〜6/25"） */
    function rangeLabel(start: string, end: string): string {
      const sd = isoDate(start);
      const ed = isoDate(end);
      const [sy, sm, sday] = sd.split('-').map(Number);
      const [ey, em, eday] = ed.split('-').map(Number);
      const md = (m: number, d: number) => `${m}/${d}`;

      if (sd === ed) {
        const wd = new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo',
          weekday: 'short',
        }).format(new Date(`${sd}T12:00:00+09:00`));
        return `${md(sm!, sday!)}(${wd})`;
      }
      // 月の1日〜末日ちょうどなら「M月」表記（カレンダー月表示）
      if (sy === ey && sm === em && sday === 1) {
        const lastDay = new Date(Date.UTC(sy!, sm!, 0)).getUTCDate();
        if (eday === lastDay) return `${sm}月`;
      }
      return `${md(sm!, sday!)}〜${md(em!, eday!)}`;
    }

    async function computeCounts(): Promise<void> {
      const companyId = lastCompanyId;
      const token = lastAuth;
      if (!companyId || !token) {
        postCounts([], 'no-token');
        return;
      }
      const today = todayRangeJst();
      const groups: CountGroup[] = [
        { label: '本日', results: await queryCounts(companyId, token, today.start, today.end) },
      ];

      // 検索で選択中の期間が「本日」と異なれば、その期間も追加
      const selStart = lastSearchBody?.start;
      const selEnd = lastSearchBody?.end;
      if (typeof selStart === 'string' && typeof selEnd === 'string') {
        const isToday =
          isoDate(selStart) === isoDate(today.start) &&
          isoDate(selEnd) === isoDate(today.end);
        if (!isToday) {
          groups.push({
            label: rangeLabel(selStart, selEnd),
            results: await queryCounts(companyId, token, selStart, selEnd),
          });
        }
      }
      console.info('[cheriee-karte] 店舗別件数', groups);
      postCounts(groups);
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== ORIGIN) return;
      if (isFetchRequestMessage(event.data)) {
        void refetch(event.data.ids);
        return;
      }
      if (isTodayCountsRequestMessage(event.data)) {
        void computeCounts();
        return;
      }
    });
  },
});
