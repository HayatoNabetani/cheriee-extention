import type { CherieeScheduleResponse } from './types';

export interface ReservationTableEntry {
  schedule: CherieeScheduleResponse;
  store: string;
  categoryId?: number | null;
}

const esc = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

function jstParts(value: string | undefined): {
  month: number;
  day: number;
  weekday: string;
  time: string;
} | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
    time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`,
  };
}

function dateLabel(value: string | undefined): string {
  const p = jstParts(value);
  return p ? `${p.month}/${p.day}(${p.weekday})` : '';
}

function timeLabel(value: string | undefined): string {
  return jstParts(value)?.time ?? '';
}

function notesOf(schedule: CherieeScheduleResponse): string {
  const detailNames = Array.isArray(schedule.details)
    ? schedule.details
        .map((detail) => detail?.name)
        .filter(
          (name): name is string => typeof name === 'string' && name.length > 0,
        )
    : [];
  return [schedule.animal?.customer?.memo, schedule.memo, ...detailNames]
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(' / ');
}

export function renderReservationTable(
  month: string,
  entries: ReservationTableEntry[],
): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const rows = entries
    .slice()
    .sort(
      (a, b) =>
        (a.schedule.startedAt ?? '').localeCompare(b.schedule.startedAt ?? '') ||
        a.store.localeCompare(b.store) ||
        (a.schedule.animal?.name ?? '').localeCompare(
          b.schedule.animal?.name ?? '',
        ),
    )
    .map(({ schedule, store, categoryId }) => {
      const name = schedule.animal?.name ?? '';
      const canceled = /CANCEL/i.test(schedule.status ?? '');
      const storeClass = categoryId === 54245 || store.includes('二子玉')
        ? 'store-futako'
        : categoryId === 43275 ||
            store.includes('本店') ||
            store.includes('ドッグカレッジ')
          ? 'store-honten'
          : '';
      // 送迎・備考は要望により一時的に空欄。戻す場合は次の行と入れ替える。
      // const notes = notesOf(schedule);
      const notes = '';
      return `<tr class="${canceled ? 'canceled' : ''}">
        <td class="name ${storeClass}">${esc(name)}${canceled ? '<span class="tag">キャンセル</span>' : ''}</td>
        <td class="date">${esc(dateLabel(schedule.startedAt))}</td>
        <td class="time">${esc(timeLabel(schedule.startedAt))}</td>
        <td class="date">${esc(dateLabel(schedule.endedAt))}</td>
        <td class="time">${esc(timeLabel(schedule.endedAt))}</td>
        <td class="notes">${esc(notes)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${year}年${monthNumber}月 ホテル予約表と送迎</title>
<style>
@page { size: A4 portrait; margin: 8mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #111; font-family: "Yu Gothic", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; }
h1 { margin: 0 0 8px; text-align: center; font-size: 22px; }
.meta { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-bottom: 6px; font-size: 13px; }
.legend { display: inline-block; padding: 2px 8px; border: 1px solid #aaa; border-radius: 3px; }
.store-honten { background-color: #cfe2f3 !important; }
.store-futako { background-color: #f4cccc !important; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 14px; }
th, td { border: 1px solid #333; padding: 6px 5px; vertical-align: middle; }
th { background: #ece8f5; font-weight: 700; white-space: nowrap; }
th:nth-child(1) { width: 23%; } th:nth-child(2) { width: 13%; }
th:nth-child(3) { width: 11%; } th:nth-child(4) { width: 13%; }
th:nth-child(5) { width: 11%; } th:nth-child(6) { width: 29%; }
td.time { text-align: center; font-size: 16px; font-weight: 700; }
td.date { font-weight: 700; }
td.name { font-weight: 600; } td.notes { white-space: pre-wrap; }
tr { break-inside: avoid; } tr.canceled { color: #777; background: #f3f3f3; }
.tag { display: inline-block; margin-left: 4px; padding: 1px 4px; border: 1px solid #999; border-radius: 3px; font-size: 10px; }
thead { display: table-header-group; }
</style></head><body>
<h1>${year}年${monthNumber}月　ホテル予約表と送迎</h1>
<div class="meta"><span class="legend store-honten">本店</span><span class="legend store-futako">二子玉</span><span>全${entries.length}件</span></div>
<table><thead><tr><th>犬の名前</th><th>IN日</th><th>IN時間</th><th>OUT日</th><th>OUT時間</th><th>送迎・備考</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
}
