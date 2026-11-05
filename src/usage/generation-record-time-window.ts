export const GENERATION_RECORD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** 列表和模型选项共享同一请求时刻；用户传入的日期只在近 14 天内继续缩小范围。 */
export function recentGenerationQuery<T extends { dateFrom?: string; dateTo?: string }>(
  query: T,
  now: Date
): T & { dateFrom: string; dateTo: string } {
  const earliest = now.getTime() - GENERATION_RECORD_WINDOW_MS
  const from = query.dateFrom ? new Date(query.dateFrom).getTime() : earliest
  let to = query.dateTo ? new Date(query.dateTo).getTime() : now.getTime()
  if (query.dateTo && !query.dateTo.includes("T")) {
    const nextDay = new Date(query.dateTo)
    nextDay.setDate(nextDay.getDate() + 1)
    to = nextDay.getTime() - 1
  }
  return {
    ...query,
    dateFrom: new Date(Math.max(earliest, from)).toISOString(),
    dateTo: new Date(Math.min(now.getTime(), to)).toISOString(),
  }
}
