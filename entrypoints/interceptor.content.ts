import {
  KARTE_MESSAGE_SOURCE,
  type ScheduleCapturedMessage,
  type CherieeScheduleResponse,
} from '@/lib/types';

/**
 * MAINワールド。ページの fetch / XMLHttpRequest をラップし、
 * `GET /v2/companies/{companyId}/schedules/{数値id}` のレスポンスを横取りして
 * window.postMessage で ISOLATED 側 (ui.content) へ渡す。
 *
 * パッシブキャプチャ: ページの正規リクエストに相乗りするため、JWT を自前で
 * 抜き出す・保存する必要がない。トークン/PII は外部送信・永続化しない。
 */
export default defineContentScript({
  matches: ['https://cheriee.biz/*'],
  // ページ自身の fetch/XHR より前にパッチを当てるため document_start。
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    // /v2/companies/{companyId}/schedules/{数値id} にマッチ（末尾やクエリも許容）
    const SCHEDULE_RE =
      /\/v2\/companies\/[^/]+\/schedules\/(\d+)(?:[/?#]|$)/;

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
      // origin を明示して同一オリジンへのみ送信
      window.postMessage(msg, window.location.origin);
    }

    function matchScheduleUrl(url: string | undefined): string | null {
      if (!url) return null;
      const m = SCHEDULE_RE.exec(url);
      return m && m[1] ? m[1] : null;
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
          const hit = headers.find(
            ([k]) => k.toLowerCase() === 'authorization',
          );
          return hit?.[1];
        }
        // Record 形式
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

      const scheduleId = matchScheduleUrl(url);
      if (scheduleId) {
        const auth =
          authFromHeaders(init?.headers) ??
          (input instanceof Request
            ? input.headers.get('authorization') ?? undefined
            : undefined);
        promise
          .then((res) => {
            // 本体を消費しないよう clone してから読む
            res
              .clone()
              .json()
              .then((data: CherieeScheduleResponse) =>
                emit(scheduleId, data, url, auth),
              )
              .catch(() => {
                /* JSONでないレスポンスは無視 */
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
      }
      return origSetHeader.call(this, name, value);
    };

    proto.send = function (this: PatchedXHR, ...args: unknown[]) {
      const scheduleId = matchScheduleUrl(this.__cheriee_url);
      if (scheduleId) {
        this.addEventListener('load', () => {
          try {
            const rt = this.responseType;
            let data: CherieeScheduleResponse | null = null;
            if (rt === '' || rt === 'text') {
              data = JSON.parse(this.responseText);
            } else if (rt === 'json') {
              data = this.response as CherieeScheduleResponse;
            }
            if (data) {
              emit(scheduleId, data, this.__cheriee_url, this.__cheriee_auth);
            }
          } catch {
            /* JSONでない/解析失敗は無視 */
          }
        });
      }
      // @ts-expect-error 可変長を原関数へ素通し
      return origSend.apply(this, args);
    };
  },
});
