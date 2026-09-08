import { addDays, dateKey } from './rankings.mjs';

export const WEEKLY_CONTENT_EXPECTED_DAYS = 7;

export function getWeeklyContentWindow(now = new Date()) {
  const currentDateKey = dateKey(now);
  const weekday = new Date(`${currentDateKey}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const runWeekStart = addDays(currentDateKey, -daysSinceMonday);
  const targetWeekStart = addDays(runWeekStart, 7);
  const targetWeekEnd = addDays(runWeekStart, 13);
  return {
    runWeekStart,
    targetWeekStart,
    targetWeekEnd,
    targetDateKeys: Array.from(
      { length: WEEKLY_CONTENT_EXPECTED_DAYS },
      (_, index) => addDays(targetWeekStart, index)
    )
  };
}

export function getWeeklyContentHealthStorageKey(runWeekStart = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(runWeekStart || ''))
    ? `operations-health:weekly:next-week:${runWeekStart}`
    : '';
}
