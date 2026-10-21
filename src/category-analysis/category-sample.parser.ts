import { BadRequestException } from "@nestjs/common"
import * as XLSX from "xlsx"
import { deduplicateParents, textValue } from "./category-analysis.math"
import type { SampleRow } from "./category-analysis.types"

const ALIASES: Record<string, string[]> = {
  asin: ["ASIN"],
  parent: ["父ASIN", "Parent ASIN"],
  brand: ["品牌", "Brand"],
  price: ["价格", "Price"],
  sales: ["销量(父)", "销量（父）", "月销量", "销量", "Monthly Sales"],
  revenue: ["销售额", "Revenue"],
  growth: ["增长率", "Growth"],
  rating: ["评分", "Rating"],
  reviews: ["评分数", "评论数", "Reviews"],
  reviewsNew: ["月新增", "Monthly Reviews"],
  seller: ["BuyBox卖家", "Buy Box Seller"],
  sellerCount: ["卖家", "Sellers"],
  sellerCountry: ["卖家所属地", "Seller Country"],
  launchDays: ["上架时间", "上架天数", "Launch Date"],
  weightLb: ["包装重量", "Weight"],
  fbaFee: ["FBA", "FBA费用", "FBA Fee"],
  cuft: ["包装尺寸", "Package Dimensions"],
  sizeTier: ["尺寸分段", "Size Tier"],
  lqs: ["LQS"],
  aplus: ["A+"],
  bs: ["BS"],
  ac: ["AC"],
}

export function parseExportNumber(value: unknown): number | null {
  if (!textValue(value).trim()) return null
  const source = textValue(value).replace(/,/g, "").trim()
  const match = source.match(/[-+]?\d+(?:\.\d+)?/)
  if (!match) return null
  let number = Number(match[0])
  if (/万/.test(source)) number *= 10000
  else if (/\d\s*[kK]/.test(source)) number *= 1000
  else if (/\d\s*[mM]/.test(source)) number *= 1000000
  if (source.includes("↓")) number = -Math.abs(number)
  return Number.isFinite(number) ? number : null
}
export function parseCubicFeet(value: unknown): number | null {
  const source = textValue(value).trim()
  const dimensions = source.match(
    /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i
  )
  if (!dimensions) return null
  const unit = /inches?|\bin\b|英寸|"/i.test(source)
    ? 12
    : /\bcm\b|厘米/i.test(source)
      ? 30.48
      : /\bmm\b|毫米/i.test(source)
        ? 304.8
        : /feet|foot|\bft\b|英尺/i.test(source)
          ? 1
          : null
  if (unit === null) return null
  return dimensions.slice(1).reduce((volume, dimension) => (volume * Number(dimension)) / unit, 1)
}
function parseDays(value: unknown, month: string): number | null {
  const source = textValue(value).trim()
  if (!source) return null
  if (/年|个月|天/.test(source) && !/\d{4}年/.test(source))
    return (
      Number(source.match(/(\d+)年/)?.[1] ?? 0) * 365 +
      Number(source.match(/(\d+)个月/)?.[1] ?? 0) * 30 +
      Number(source.match(/(\d+)天/)?.[1] ?? 0)
    )
  if (/^\d{4}[-/.]/.test(source)) {
    const date = Date.parse(source.replace(/\./g, "-"))
    const end = new Date(`${month}-01T00:00:00Z`)
    end.setUTCMonth(end.getUTCMonth() + 1)
    end.setUTCDate(0)
    return Number.isFinite(date) ? Math.max(0, Math.floor((end.getTime() - date) / 86400000)) : null
  }
  const number = parseExportNumber(value)
  // Excel 日期序号只用于有明确日期样式的上架时间，不能作为上架天数。
  if (number !== null && number > 30000) {
    const date = (
      XLSX.SSF as { parse_date_code: (value: number) => { y: number; m: number; d: number } | null }
    ).parse_date_code(number)
    return date
      ? parseDays(
          `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`,
          month
        )
      : null
  }
  return number
}
export function parseSampleTable(table: unknown[][], filename: string) {
  const matchedMonth = filename.match(/(20\d{2})[-_]?([01]\d)/)
  if (!matchedMonth || Number(matchedMonth[2]) < 1 || Number(matchedMonth[2]) > 12)
    throw new BadRequestException("文件名需包含有效月份，例如 2026-08 或 202608")
  const month = `${matchedMonth[1]}-${matchedMonth[2]}`
  const normalize = (value: unknown) => textValue(value).trim().toLowerCase().replace(/\s/g, "")
  const locate = (headers: unknown[], aliases: string[]) => {
    const exact = headers.findIndex(header =>
      aliases.some(alias => normalize(header) === normalize(alias))
    )
    return exact >= 0
      ? exact
      : headers.findIndex(header =>
          aliases.some(
            alias =>
              normalize(header).startsWith(normalize(alias)) &&
              !Object.values(ALIASES)
                .flat()
                .some(
                  other =>
                    normalize(other).length > normalize(alias).length &&
                    normalize(header).startsWith(normalize(other))
                )
          )
        )
  }
  const headerIndex = table
    .slice(0, 15)
    .findIndex(
      row => Object.values(ALIASES).filter(aliases => locate(row, aliases) >= 0).length >= 3
    )
  if (headerIndex < 0) throw new BadRequestException("前 15 行中未识别到有效样本表头")
  const headers = table[headerIndex],
    columns = Object.fromEntries(
      Object.entries(ALIASES).map(([key, aliases]) => [key, locate(headers, aliases)])
    )
  // 评分与评分数、ASIN与父ASIN必须优先精确匹配，避免前缀误判。
  const data = table.slice(headerIndex + 1)
  const sellerValues = data
    .map(row => row[columns.sellerCount])
    .filter(value => Boolean(textValue(value).trim()))
  const hasSellerCounts =
    sellerValues.length > 0 &&
    sellerValues.filter(value => /^\s*\d+(?:\.\d+)?\s*(家)?\s*$/.test(textValue(value))).length /
      sellerValues.length >=
      0.7
  const rows: SampleRow[] = data.flatMap(row => {
    const get = (key: string) => (columns[key] >= 0 ? row[columns[key]] : null)
    const text = (key: string) => {
      const value = textValue(get(key)).trim()
      return !value || /^(?:[-—–]+|n\/?a|null|undefined|暂无|无数据)$/i.test(value) ? null : value
    }
    const number = (key: string) => parseExportNumber(get(key))
    const flag = (key: string) => {
      const value = text(key)
      if (value === null) return null
      if (/^(yes|true|1|是|有|✓|√|A\+|BS|AC)$/i.test(value)) return true
      return /^(no|false|0|否|无|×)$/i.test(value) ? false : null
    }
    const asin = text("asin")?.toUpperCase()
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return []
    const price = number("price"),
      sales = number("sales"),
      weightText = text("weightLb"),
      weight = number("weightLb"),
      growth = number("growth")
    return [
      {
        asin,
        parent: /^[A-Z0-9]{10}$/i.test(text("parent") ?? "") ? text("parent")!.toUpperCase() : null,
        brand: text("brand"),
        price,
        sales,
        revenue: number("revenue") ?? (price !== null && sales !== null ? price * sales : null),
        growth: growth === null ? null : growth / 100,
        rating: number("rating"),
        reviews: number("reviews"),
        reviewsNew: number("reviewsNew"),
        seller: text("seller") ?? (!hasSellerCounts ? text("sellerCount") : null),
        sellerCount: hasSellerCounts ? number("sellerCount") : null,
        sellerCountry: text("sellerCountry"),
        launchDays: parseDays(get("launchDays"), month),
        weightLb:
          weight === null
            ? null
            : /ounces?|\boz\b/i.test(weightText ?? "")
              ? weight / 16
              : /\bkg\b|千克/i.test(weightText ?? "")
                ? weight * 2.2046226218
                : /\bg\b|克/.test(weightText ?? "")
                  ? weight / 453.59237
                  : weight,
        fbaFee: number("fbaFee"),
        cuft: parseCubicFeet(get("cuft")),
        sizeTier: text("sizeTier"),
        lqs: number("lqs"),
        aplus: flag("aplus"),
        bs: flag("bs"),
        ac: flag("ac"),
      },
    ]
  })
  if (!rows.length) throw new BadRequestException("文件中没有有效 ASIN 样本")
  return { month, rows: deduplicateParents(rows) }
}
export function parseSampleFile(buffer: Buffer, filename: string) {
  if (!/\.(xlsx|csv)$/i.test(filename)) throw new BadRequestException("仅支持 xlsx 或 csv 样本文件")
  try {
    const workbook = XLSX.read(buffer, { type: "buffer", sheetRows: 20016 })
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    return parseSampleTable(
      XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: null, raw: false }),
      filename
    )
  } catch (error) {
    if (error instanceof BadRequestException) throw error
    throw new BadRequestException("样本文件无法解析")
  }
}
