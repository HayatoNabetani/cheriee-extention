import { isScheduleCapturedMessage, type ScheduleCapturedMessage } from '@/lib/types';
import { mapResponseToKarte } from '@/lib/mapResponseToKarte';
import { renderKarte } from '@/lib/renderKarte';

/**
 * ISOLATEDワールド。interceptor(MAIN) が横取りしたレスポンスを受信してキャッシュし、
 * 予約詳細に「🖨 印刷」ボタンを出す。クリックで現在開いている予約をカルテ印刷する。
 *
 * 〔要確認①〕ボタン配置: 実DOMが未確定なため、確実に動くフローティングボタンを基本とし、
 *            既知ツールバー（予約表/会計/記録/編集）が見つかれば、そこへも注入する。
 * 〔要確認⑤〕連絡先(PII)掲載: INCLUDE_CONTACT で切替（既定: 掲載）。
 * 〔要確認②〕スタッフ名: STAFF_NAMES に辞書を入れれば ID→名前を解決。空なら ID 表示。
 */
export default defineContentScript({
  matches: ['https://cheriee.biz/*'],
  runAt: 'document_end',
  world: 'ISOLATED',
  main() {
    const BUTTON_ID = 'cheriee-karte-print-btn';
    const INCLUDE_CONTACT = true; // §6 要確認⑤
    const STAFF_NAMES: Record<number, string> = {}; // §5 要確認②

    /** scheduleId → 捕捉メッセージ。開いた予約を覚えておき再印刷を可能に。 */
    const cache = new Map<string, ScheduleCapturedMessage>();
    let latestId: string | null = null;

    /* ───────── 捕捉データ受信 ───────── */
    window.addEventListener('message', (event) => {
      if (event.source !== window) return; // 同一ウィンドウのみ
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!isScheduleCapturedMessage(data)) return;
      cache.set(data.scheduleId, data);
      latestId = data.scheduleId;
      updateButtonState();
    });

    /* ───────── 印刷対象の決定 ─────────
     * URL に数値 scheduleId があり、かつ捕捉済みならそれを優先。
     * それ以外は「最後に開いた予約 = 最新の捕捉」を対象にする。 */
    function getTargetId(): string | null {
      const m = /\/schedules\/(\d+)/.exec(window.location.pathname);
      if (m && m[1] && cache.has(m[1])) return m[1];
      return latestId;
    }

    /* ───────── 印刷実行 ───────── */
    function printKarte(): void {
      const id = getTargetId();
      const captured = id ? cache.get(id) : undefined;
      if (!captured) {
        alert(
          '印刷対象の予約データを取得できていません。\n予約を開いてから印刷してください。',
        );
        return;
      }

      const karte = mapResponseToKarte(captured.data, {
        staffNames: STAFF_NAMES,
      });

      if (karte.canceled) {
        const ok = confirm(
          `この予約はキャンセル系ステータス（${karte.status}）です。\nそのまま印刷しますか？`,
        );
        if (!ok) return;
      }

      const html = renderKarte(karte, { includeContact: INCLUDE_CONTACT });
      const w = window.open('', '_blank', 'width=840,height=1040');
      if (!w) {
        alert(
          'ポップアップがブロックされました。\nこのサイトのポップアップを許可してください。',
        );
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();

      const doPrint = () => {
        w.focus();
        w.print();
      };
      // 描画完了後に印刷ダイアログを出す
      if (w.document.readyState === 'complete') {
        window.setTimeout(doPrint, 300);
      } else {
        w.addEventListener('load', () => window.setTimeout(doPrint, 300));
      }
    }

    /* ───────── ボタン生成（フローティング） ───────── */
    function createFloatingButton(): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.id = BUTTON_ID;
      btn.type = 'button';
      btn.textContent = '🖨 印刷';
      btn.title = 'この予約をご予約カルテ形式で印刷します';
      Object.assign(btn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        padding: '10px 16px',
        fontSize: '14px',
        fontWeight: '600',
        color: '#fff',
        background: '#2b7de9',
        border: 'none',
        borderRadius: '24px',
        boxShadow: '0 2px 8px rgba(0,0,0,.3)',
        cursor: 'pointer',
      } satisfies Partial<CSSStyleDeclaration>);
      btn.addEventListener('click', printKarte);
      return btn;
    }

    function ensureFloatingButton(): void {
      if (document.getElementById(BUTTON_ID)) return;
      document.body.appendChild(createFloatingButton());
      updateButtonState();
    }

    function updateButtonState(): void {
      const btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
      if (!btn) return;
      const hasTarget = getTargetId() != null;
      btn.disabled = !hasTarget;
      btn.style.opacity = hasTarget ? '1' : '0.5';
      btn.style.cursor = hasTarget ? 'pointer' : 'not-allowed';
    }

    /* ───────── ツールバー注入（ベストエフォート・要確認①） ─────────
     * 予約詳細ツールバーの「編集」ボタンを見つけたら、その隣へ印刷ボタンを差し込む。
     * 見つからなくてもフローティングボタンで操作できるため必須ではない。 */
    function tryInjectToolbar(): void {
      if (document.getElementById(`${BUTTON_ID}-tb`)) return;
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
      );
      const editBtn = candidates.find(
        (el) => el.textContent?.trim() === '編集',
      );
      if (!editBtn || !editBtn.parentElement) return;

      const tb = document.createElement('button');
      tb.id = `${BUTTON_ID}-tb`;
      tb.type = 'button';
      tb.textContent = '🖨 印刷';
      tb.title = 'この予約をご予約カルテ形式で印刷します';
      Object.assign(tb.style, {
        marginLeft: '8px',
        padding: '4px 10px',
        fontSize: '13px',
        cursor: 'pointer',
      } satisfies Partial<CSSStyleDeclaration>);
      tb.addEventListener('click', printKarte);
      editBtn.parentElement.appendChild(tb);
    }

    /* ───────── 起動 ─────────
     * SPA なので DOM 変化を監視し、ボタンの存在とツールバー注入を維持。 */
    ensureFloatingButton();
    tryInjectToolbar();

    const observer = new MutationObserver(() => {
      ensureFloatingButton();
      tryInjectToolbar();
      updateButtonState();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
