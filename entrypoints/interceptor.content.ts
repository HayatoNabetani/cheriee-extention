import {
  KARTE_MESSAGE_SOURCE,
  isFetchRequestMessage,
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
    // /v2/companies/{companyId}/schedules（末尾やクエリのみ。/{id} は含まない）
    const LIST_RE = /\/v2\/companies\/([^/]+)\/schedules(?:[/?#]|$)/;

    // 再取得に使うため、直近に見た会社IDとトークンを保持（メモリのみ）。
    let lastCompanyId: string | undefined;
    let lastAuth: string | undefined;

    function rememberCreds(companyId?: string, auth?: string): void {
      if (companyId) lastCompanyId = companyId;
      if (auth) lastAuth = auth;
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

    /** 横取りした生テキスト/JSONを詳細 or 一覧として処理 */
    function handleBody(url: string | undefined, parse: () => unknown): void {
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

      if (detailMatch(url) || listMatch(url)) {
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
      if (detailMatch(url) || listMatch(url)) {
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

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== ORIGIN) return;
      if (!isFetchRequestMessage(event.data)) return;
      void refetch(event.data.ids);
    });
  },
});
