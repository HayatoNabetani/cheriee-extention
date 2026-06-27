/**
 * シェリー詳細API (`GET /v2/companies/{companyId}/schedules/{scheduleId}`) の
 * レスポンス型（実測ベース・部分定義）。付録A参照。
 *
 * 実APIは未定義フィールドを追加し得るため、すべて optional として扱い、
 * マッピング側（mapResponseToKarte）で安全に欠損を吸収する。
 */

export interface CherieeCustomer {
  lastName?: string;
  firstName?: string;
  postalCode?: string;
  prefecture?: string;
  city?: string;
  address?: string;
  telephone1?: string;
  telephone2?: string;
  /** その他欄候補（例「送迎」） */
  memo?: string;
}

export interface CherieeAnimal {
  name?: string;
  nameKana?: string;
  type?: string; // 例 "DOGS"
  breed?: string;
  /** 年齢算出に使用（例 "2024-10-25"） */
  birthday?: string;
  /** "MALE" | "FEMALE" | その他 */
  sex?: string;
  castrated?: boolean;
  /** お薬 有/無 */
  dosaged?: boolean;
  picture?: string;
  customer?: CherieeCustomer;
}

export interface CherieeCategory {
  /** 例 "PET_HOTEL" / "GROOMING" 等 */
  category?: string;
  /** 表示名（例 "ペットホテル"） */
  name?: string;
}

export interface CherieeScheduleDetail {
  /** 明細行（S/SC/内容）。トリミング予約だと入る想定。空のことあり。 */
  name?: string;
  type?: string;
  quantity?: number;
  price?: number;
  [key: string]: unknown;
}

export interface CherieeInvoice {
  status?: string; // 例 "AVAILABLE"
  total?: number;
  details?: unknown[];
}

export interface CherieeScheduleResponse {
  id?: number;
  /** 予約番号（UI表示・例 "18afbd17"） */
  code?: string;
  createdAt?: string; // UTC
  updatedAt?: string; // UTC
  /** 担当スタッフID（名前は別途解決） */
  staffId?: number;
  type?: string; // 例 "BASIC"
  route?: string; // 予約経路 例 "TEL"
  /** 来店済み等。キャンセル判定に使用。例 "COMPLETE" / "CANCELED" */
  status?: string;
  startedAt?: string; // UTC お預り(IN)
  endedAt?: string; // UTC お迎え(OUT)
  paid?: boolean;
  total?: number;
  tax?: number;
  totalTime?: number; // 0のことあり→自前算出
  memo?: string; // 備考
  category?: CherieeCategory;
  details?: CherieeScheduleDetail[];
  animal?: CherieeAnimal;
  invoice?: CherieeInvoice;
  [key: string]: unknown;
}

/* ───────── interceptor(MAIN) ⇄ ui(ISOLATED) 間のメッセージ ───────── */

/** window.postMessage で渡すメッセージの識別子 */
export const KARTE_MESSAGE_SOURCE = 'cheriee-karte' as const;

export interface ScheduleCapturedMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'schedule-response';
  scheduleId: string;
  data: CherieeScheduleResponse;
  /** 横取り時に控えた Authorization（補助方式での再フェッチ用。任意） */
  auth?: string;
  /** リクエストURL（companyId 抽出等に利用可） */
  url?: string;
}

export function isScheduleCapturedMessage(
  value: unknown,
): value is ScheduleCapturedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.source === KARTE_MESSAGE_SOURCE &&
    m.type === 'schedule-response' &&
    typeof m.scheduleId === 'string' &&
    typeof m.data === 'object' &&
    m.data !== null
  );
}

/** 一覧API横取りで得た予約IDの集合（MAIN → ISOLATED） */
export interface ScheduleListMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'schedule-list';
  /** 一覧に含まれる予約ID（文字列化済み） */
  ids: string[];
}

export function isScheduleListMessage(
  value: unknown,
): value is ScheduleListMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.source === KARTE_MESSAGE_SOURCE &&
    m.type === 'schedule-list' &&
    Array.isArray(m.ids)
  );
}

/** 詳細の再取得依頼（ISOLATED → MAIN）。保存済みトークンで MAIN がfetchする。 */
export interface FetchRequestMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'fetch-request';
  ids: string[];
}

export function isFetchRequestMessage(
  value: unknown,
): value is FetchRequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.source === KARTE_MESSAGE_SOURCE &&
    m.type === 'fetch-request' &&
    Array.isArray(m.ids)
  );
}

/** 再取得の完了通知（MAIN → ISOLATED） */
export interface FetchDoneMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'fetch-done';
  ids: string[];
  /** 取得失敗件数 */
  errors: number;
  /** トークン/会社ID未取得などで実行できなかった場合の理由 */
  reason?: 'no-token';
}

export function isFetchDoneMessage(
  value: unknown,
): value is FetchDoneMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.source === KARTE_MESSAGE_SOURCE && m.type === 'fetch-done';
}

/** 表示中の期間（検索ボディ/カレンダークエリ）を捕捉した通知（MAIN → ISOLATED）。
 * これを受けて ISOLATED 側が店舗別件数を再取得する。 */
export interface RangeCapturedMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'range-captured';
}

export function isRangeCapturedMessage(
  value: unknown,
): value is RangeCapturedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.source === KARTE_MESSAGE_SOURCE && m.type === 'range-captured';
}

/** 本日の店舗別予約数の取得依頼（ISOLATED → MAIN） */
export interface TodayCountsRequestMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'today-counts-request';
}

export function isTodayCountsRequestMessage(
  value: unknown,
): value is TodayCountsRequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.source === KARTE_MESSAGE_SOURCE && m.type === 'today-counts-request';
}

/** 1店舗ぶんの件数（count が null は取得失敗） */
export interface TenantCount {
  name: string;
  count: number | null;
}

/** 表示する1グループ（例: 本日 / 選択日）の店舗別件数 */
export interface CountGroup {
  /** 見出しラベル（例 "本日" / "6/23(火)"） */
  label: string;
  results: TenantCount[];
}

/** 店舗別予約数（MAIN → ISOLATED）。groups[0]=本日, [1]=選択日(任意) */
export interface TodayCountsMessage {
  source: typeof KARTE_MESSAGE_SOURCE;
  type: 'today-counts';
  groups: CountGroup[];
  reason?: 'no-token';
}

export function isTodayCountsMessage(
  value: unknown,
): value is TodayCountsMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.source === KARTE_MESSAGE_SOURCE &&
    m.type === 'today-counts' &&
    Array.isArray(m.groups)
  );
}
