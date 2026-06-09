import type { CherieeScheduleResponse } from './types';

/**
 * カルテ1枚を描画するために必要な、整形済みの値一式。
 * `renderKarte` はこのオブジェクトだけを受け取って HTML を生成する。
 * 取得不能な項目（§5の ✗）は空文字にして、印刷後の手書きに委ねる。
 */
export interface Karte {
  /** 区分: トリミング / ホテル / その他 */
  category: 'トリミング' | 'ホテル' | 'その他' | '';
  /** 区分の表示名（category.name） */
  categoryLabel: string;
  /** 受付者（解決できなければ ID 文字列、無ければ空） */
  staff: string;
  /** 受付日 YYYY/MM/DD (JST) */
  receivedDate: string;
  /** 予約番号(code) */
  code: string;
  /** ペット名 */
  animalName: string;
  /** 犬種 */
  breed: string;
  /** ♂ / ♀ / '' */
  sexMark: '♂' | '♀' | '';
  /** 年齢（例 "1歳"）。算出不能なら空 */
  age: string;
  /** 期間表示（例 "06/08 10:30 〜 06/11 16:30"） */
  period: string;
  /** 泊数・日数表示（例 "3泊4日"）。同日内は空 */
  stay: string;
  /** IN 時刻 HH:mm (JST) */
  inTime: string;
  /** OUT 時刻 HH:mm (JST) */
  outTime: string;
  /** お会計 済 / 未 */
  paid: '済' | '未' | '';
  /** 予定金額（カンマ区切り。例 "0"） */
  amount: string;
  /** 明細（S/SC/内容）。本例は空配列のことあり */
  details: string[];
  /** お薬 有 / 無 */
  medicine: '有' | '無' | '';
  /** その他（飼い主メモ） */
  other: string;
  /** 備考（予約メモ） */
  memo: string;
  /** 連絡先（PII・印刷要否は §6 で決定） */
  contact: {
    name: string;
    postalCode: string;
    address: string;
    tel: string;
  };
  /** キャンセル系ステータスか */
  canceled: boolean;
  /** 元の status 文字列 */
  status: string;
}

const JST_TZ = 'Asia/Tokyo';

/** UTC ISO 文字列を JST の Date 各成分へ分解（Intl で確実に +9h 変換） */
function toJstParts(iso: string | undefined): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: JST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get('hour');
  // Intl が 24 を返すケース（深夜0時）を 0 に正規化
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** JST 日付 YYYY/MM/DD */
function formatJstDate(iso: string | undefined): string {
  const p = toJstParts(iso);
  if (!p) return '';
  return `${p.year}/${pad2(p.month)}/${pad2(p.day)}`;
}

/** JST 時刻 HH:mm */
function formatJstTime(iso: string | undefined): string {
  const p = toJstParts(iso);
  if (!p) return '';
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 期間表示 MM/DD HH:mm */
function formatJstShort(iso: string | undefined): string {
  const p = toJstParts(iso);
  if (!p) return '';
  return `${pad2(p.month)}/${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 区分マッピング: PET_HOTEL→ホテル / GROOMING|TRIMMING→トリミング / 他→その他 */
function mapCategory(category: string | undefined): Karte['category'] {
  if (!category) return '';
  const c = category.toUpperCase();
  if (c.includes('HOTEL')) return 'ホテル';
  if (c.includes('GROOMING') || c.includes('TRIMMING')) return 'トリミング';
  return 'その他';
}

function mapSex(sex: string | undefined): Karte['sexMark'] {
  if (sex === 'MALE') return '♂';
  if (sex === 'FEMALE') return '♀';
  return '';
}

/**
 * 誕生日(YYYY-MM-DD)と基準日から満年齢を算出。
 * 0歳のとき月齢にせず「0歳」を返す（カルテ年齢欄の都合に合わせ調整可）。
 */
export function calcAge(
  birthday: string | undefined,
  now: Date = new Date(),
): string {
  if (!birthday) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday);
  if (!m) return '';
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const bd = Number(m[3]);
  // 基準日も JST で評価
  const nowParts = toJstParts(now.toISOString());
  if (!nowParts) return '';
  let age = nowParts.year - by;
  if (
    nowParts.month < bm ||
    (nowParts.month === bm && nowParts.day < bd)
  ) {
    age -= 1;
  }
  if (age < 0) return '';
  return `${age}歳`;
}

/**
 * 泊数・日数を JST 暦日差から算出。
 * 同日内（暦日差0）は空文字（トリミング等は泊数欄を使わない）。
 * `totalTime` は 0 のことがあるため使用しない。
 */
export function calcStay(
  startedAt: string | undefined,
  endedAt: string | undefined,
): string {
  const s = toJstParts(startedAt);
  const e = toJstParts(endedAt);
  if (!s || !e) return '';
  // 時刻を捨てた暦日でUTCミリ秒化し、純粋な日数差を取る
  const sDay = Date.UTC(s.year, s.month - 1, s.day);
  const eDay = Date.UTC(e.year, e.month - 1, e.day);
  const nights = Math.round((eDay - sDay) / 86_400_000);
  if (nights <= 0) return '';
  return `${nights}泊${nights + 1}日`;
}

function formatAmount(n: number | undefined): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return '';
  return n.toLocaleString('ja-JP');
}

/** キャンセル系ステータス判定 */
function isCanceled(status: string | undefined): boolean {
  if (!status) return false;
  return /CANCEL/i.test(status);
}

/** details[] からカルテ明細の文字列配列を作る */
function mapDetails(details: CherieeScheduleResponse['details']): string[] {
  if (!Array.isArray(details)) return [];
  return details
    .map((d) => {
      const name = typeof d?.name === 'string' ? d.name : '';
      const qty =
        typeof d?.quantity === 'number' && d.quantity > 1
          ? ` ×${d.quantity}`
          : '';
      return `${name}${qty}`.trim();
    })
    .filter((s) => s.length > 0);
}

export interface MapOptions {
  /** staffId → スタッフ名の解決辞書（要確認②）。無ければ ID を表示。 */
  staffNames?: Record<number, string>;
  /** 年齢算出の基準日（テスト用） */
  now?: Date;
}

/**
 * 詳細APIレスポンスをカルテ描画用オブジェクトへ変換する純関数。
 * 欠損・型不一致に対して安全（空文字へフォールバック）。
 */
export function mapResponseToKarte(
  res: CherieeScheduleResponse,
  opts: MapOptions = {},
): Karte {
  const animal = res.animal ?? {};
  const owner = animal.customer ?? {};

  const staff = (() => {
    if (res.staffId == null) return '';
    const name = opts.staffNames?.[res.staffId];
    return name ?? String(res.staffId);
  })();

  const contactName =
    [owner.lastName, owner.firstName].filter(Boolean).join(' ').trim() || '';
  const contactAddress =
    [owner.prefecture, owner.city, owner.address].filter(Boolean).join('') ||
    '';
  const tel = [owner.telephone1, owner.telephone2]
    .filter(Boolean)
    .join(' / ');

  // 予定金額: invoice.total を優先、無ければ total
  const amountSource =
    typeof res.invoice?.total === 'number' ? res.invoice.total : res.total;

  return {
    category: mapCategory(res.category?.category),
    categoryLabel: res.category?.name ?? '',
    staff,
    receivedDate: formatJstDate(res.createdAt),
    code: res.code ?? '',
    animalName: animal.name ?? '',
    breed: animal.breed ?? '',
    sexMark: mapSex(animal.sex),
    age: calcAge(animal.birthday, opts.now),
    period:
      res.startedAt || res.endedAt
        ? `${formatJstShort(res.startedAt)} 〜 ${formatJstShort(res.endedAt)}`
        : '',
    stay: calcStay(res.startedAt, res.endedAt),
    inTime: formatJstTime(res.startedAt),
    outTime: formatJstTime(res.endedAt),
    paid: res.paid === true ? '済' : res.paid === false ? '未' : '',
    amount: formatAmount(amountSource),
    details: mapDetails(res.details),
    medicine: animal.dosaged === true ? '有' : animal.dosaged === false ? '無' : '',
    other: owner.memo ?? '',
    memo: res.memo ?? '',
    contact: {
      name: contactName,
      postalCode: owner.postalCode ?? '',
      address: contactAddress,
      tel,
    },
    canceled: isCanceled(res.status),
    status: res.status ?? '',
  };
}
