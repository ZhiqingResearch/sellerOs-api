/** 导出默认时区：tz 缺省/非法时回落（国内用户为主） */
export const DEFAULT_EXPORT_TZ = "Asia/Shanghai"

/**
 * 导出用时间格式化器：YYYY-MM-DD HH:mm:ss，按 IANA 时区名（前端传
 * Intl.DateTimeFormat().resolvedOptions().timeZone）；缺省/非法回落 DEFAULT_EXPORT_TZ。
 * CSV 导出统一用它（收据 / 订阅名单等）。
 */
export function exportDateTimeFormatter(tz?: string): (d: Date) => string {
  const build = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
  const wanted = tz?.trim() || DEFAULT_EXPORT_TZ
  let dtf: Intl.DateTimeFormat
  try {
    dtf = build(wanted)
  } catch {
    dtf = build(DEFAULT_EXPORT_TZ)
  }
  return (d: Date) => {
    const p = Object.fromEntries(dtf.formatToParts(d).map(x => [x.type, x.value] as const))
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
  }
}

/** 导出用纯日期格式化器：YYYY-MM-DD（不带时分秒），时区处理同 exportDateTimeFormatter */
export function exportDateFormatter(tz?: string): (d: Date) => string {
  const fmt = exportDateTimeFormatter(tz)
  return (d: Date) => fmt(d).slice(0, 10)
}

/** CSV 单元格转义（含逗号/引号/换行时加引号） */
export function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** 东八区固定偏移（无夏令时） */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 北京自然月起点：now 所在北京自然月 1 日 00:00（东八区）对应的绝对时点。
 * offsetMonths 取负/正可前后偏移整月（如 -1 = 上个北京自然月起点）。
 *
 * 凡「自然月」口径（返利月封顶 / 钱包本月已用 / 分销本月统计 / 团队配额懒重置 / 本月消耗）
 * 统一用它，**不要**用 `new Date(y, m, 1)` 或 `setDate(1)+setHours(0,0,0,0)`——那是服务器
 * 本地时区口径，容器为 UTC 时，北京时间每月 1 日 00:00–08:00 会错算到上个月（与 @Cron
 * 一律 timeZone: "Asia/Shanghai" 同因）。
 */
export function beijingMonthStart(now: Date = new Date(), offsetMonths = 0): Date {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS)
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + offsetMonths, 1) - BEIJING_OFFSET_MS
  )
}

/** 北京自然月键 YYYY-MM（配额懒重置 quotaMonth 等，与 beijingMonthStart 同口径） */
export function beijingMonthKey(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS)
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  return `${shifted.getUTCFullYear()}-${m}`
}

/**
 * 北京自然日边界：把 "YYYY-MM-DD" 日期串按北京自然日取当天 00:00:00.000 对应的绝对时点；
 * 非法/越界输入（如 2026-02-31）返回 null（调用方决定 400）。
 * 「起止日期筛选」统一用它/它+beijingDayEnd，**不要** `new Date("YYYY-MM-DD")`——那是 UTC
 * 零点口径，容器 UTC 时比北京当天 00:00 晚 8 小时（与北京自然月 beijingMonthStart 同因）。
 */
export function beijingDayStart(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const start = new Date(Date.UTC(+y, +mo - 1, +d) - BEIJING_OFFSET_MS)
  // 回读校验：2026-02-31 这类越界日期会被 Date.UTC 顺延到下月，判非法
  const back = new Date(start.getTime() + BEIJING_OFFSET_MS)
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) {
    return null
  }
  return start
}

/** 北京自然日终点：当天 23:59:59.999 对应的绝对时点（= 次日起点 -1ms）；非法输入返回 null */
export function beijingDayEnd(dateStr: string): Date | null {
  const start = beijingDayStart(dateStr)
  return start ? new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) : null
}
