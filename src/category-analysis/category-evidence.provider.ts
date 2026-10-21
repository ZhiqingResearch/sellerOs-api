import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Prisma } from "@prisma/client"
import axios from "axios"
import { createHash } from "crypto"
import { canonicalJson } from "../common/utils/canonical-json"
import { PrismaService } from "../prisma/prisma.service"
import {
  calculateYoy,
  classifyKeyword,
  divide,
  numberOrNull,
  sum,
  textValue,
} from "./category-analysis.math"
import type {
  CategoryCandidate,
  CategoryEvidence,
  CategoryKeyword,
  CategorySelection,
  HeadTrend,
  KeepaItem,
  KeywordResolution,
  MonthSample,
  SampleRow,
} from "./category-analysis.types"

import { parseHeadTrend, parseSalesHistory } from "./category-enrichment"

export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function asRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : asObject(value).list
  return Array.isArray(rows) ? rows.map(asObject) : []
}
const textOrNull = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null
const positive = (value: unknown) => {
  const number = numberOrNull(value)
  return number !== null && number >= 0 ? number : null
}
const keywordKey = (value: unknown) => textValue(value).trim().toLowerCase().replace(/\s+/g, " ")
const KEEPA_DOMAINS: Record<string, number> = { US: 1, UK: 2, DE: 3, JP: 5 }
const DAY_MS = 86400000
const SIF_CACHE_TTL_MS = 14 * DAY_MS
interface EvidenceCacheEntry {
  expiresAt: number
  promise: Promise<unknown>
}

export function selectCategory(candidates: Record<string, unknown>[], query: string, path: string) {
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(token => token && token !== "and")
  const queryTokens = tokens(query),
    pathTokens = tokens(path)
  const qualifiers = new Set([
    "toddler",
    "kids",
    "kid",
    "baby",
    "infant",
    "girls",
    "boys",
    "accessories",
    "accessory",
    "parts",
    "replacement",
    "covers",
    "cover",
    "carts",
  ])
  const matches = (token: string, values: string[]) =>
    values.some(value => value.replace(/s$/, "") === token.replace(/s$/, ""))
  return (
    candidates
      .map((category, index) => {
        const categoryTokens = tokens(textValue(category.categoryName))
        const hits = queryTokens.filter(token => matches(token, categoryTokens)).length
        const extras = categoryTokens.filter(token => !matches(token, queryTokens)).length
        const extraQualifiers = categoryTokens.filter(
          token =>
            qualifiers.has(token) && !pathTokens.includes(token) && !queryTokens.includes(token)
        ).length
        return { category, hits, score: hits * 10 - extras * 2 - extraQualifiers * 8 - index * 0.1 }
      })
      .filter(item => item.hits > 0 && item.category.categoryId !== undefined)
      .sort((a, b) => b.score - a.score)[0]?.category ?? null
  )
}

export function parseSifSample(value: unknown, now = Date.now()): SampleRow[] {
  return asRows(value).flatMap(row => {
    const price = positive(row.price),
      asin = textValue(row.asin).toUpperCase()
    if (!price || !/^[A-Z0-9]{10}$/.test(asin)) return []
    const sales = positive(row.boughtInPastMonth)
    const launchDate =
      typeof row.firstAvailableDay === "string" ? Date.parse(row.firstAvailableDay) : NaN
    return [
      {
        asin,
        title: textValue(row.title),
        parent: /^[A-Z0-9]{10}$/i.test(textValue(row.parentAsin))
          ? textValue(row.parentAsin).toUpperCase()
          : null,
        brand: textOrNull(row.brand),
        price,
        sales,
        revenue: sales === null ? null : sales * price,
        growth: null,
        rating: positive(row.score),
        reviews: positive(row.ratingNum),
        reviewsNew: null,
        seller: null,
        sellerCountry: null,
        sellerCount: null,
        launchDays: Number.isFinite(launchDate)
          ? Math.max(0, Math.round((now - launchDate) / DAY_MS))
          : null,
        weightLb: positive(row.packageWeight) === null ? null : Number(row.packageWeight) / 453.592,
        cuft: [row.packageLength, row.packageWidth, row.packageHeight].every(
          value => (positive(value) ?? 0) > 0
        )
          ? (Number(row.packageLength) * Number(row.packageWidth) * Number(row.packageHeight)) /
            28316846.6
          : null,
        sizeTier: null,
        lqs: null,
        aplus: null,
        bs:
          Array.isArray(row.bsrList) && row.bsrList.length
            ? row.bsrList.some(rank => Number(asObject(rank).rank) === 1)
            : null,
        ac: null,
      },
    ]
  })
}

export function parseKeywords(keywords: string[], responses: unknown[]): CategoryKeyword[] {
  const [overview, history, competitors, conversion, patterns] = responses.map(asRows)
  return keywords.map(keyword => {
    const find = (rows: Record<string, unknown>[]) =>
      rows.find(row => keywordKey(row.keyword) === keywordKey(keyword)) ?? {}
    const info = find(overview),
      historyMap = asObject(find(history).estSearchesNumHistoryMap),
      conversions = find(conversion)
    const historyPoints = Object.entries(historyMap)
      .filter(([month, value]) => /^\d{4}-\d{2}/.test(month) && positive(value) !== null)
      .map(([month, value]) => ({ month: month.slice(0, 7), value: Number(value) }))
      .sort((a, b) => a.month.localeCompare(b.month))
    const competitor =
      competitors
        .filter(row => keywordKey(row.keyword) === keywordKey(keyword))
        .sort((a, b) => textValue(b.startDate).localeCompare(textValue(a.startDate)))[0] ?? {}
    const traffic = patterns
      .filter(
        row =>
          keywordKey(row.keyword) === keywordKey(keyword) && positive(row.totalScoreRatio) !== null
      )
      .sort((a, b) => Number(b.totalScoreRatio) - Number(a.totalScoreRatio))
    const head = traffic[0] ?? {}
    const volume = positive(info.estSearchesNum),
      count = positive(competitor.totalAsinNum)
    const result = {
      keyword,
      search_volume: volume,
      aba_rank: positive(info.searchesRank),
      competitors: count,
      supply_demand: divide(volume, count),
      yoy_pct: calculateYoy(historyPoints),
      top3_concentration: traffic.length
        ? (sum(traffic.slice(0, 3).map(row => positive(row.totalScoreRatio))) ?? 0) * 100
        : null,
      natural_share: divide(
        positive(head.keywordAllNaturalScore ?? head.keywordNaturalScore),
        positive(head.keywordTotalScore)
      ),
      ppc: positive(asObject(conversions.ppc).median),
      cvr: positive(conversions.clickPurchaseRatio),
      acos: positive(asObject(conversions.acos).median),
      history: historyPoints,
    }
    return { ...result, ...classifyKeyword(result) }
  })
}

export function parseKeepaProducts(value: unknown, now = Date.now()): KeepaItem[] {
  const products = asObject(value).products
  if (!Array.isArray(products)) return []
  return products.map(raw => {
    const product = asObject(raw),
      stats = asObject(product.stats)
    const current = Array.isArray(stats.current) ? stats.current : [],
      average = Array.isArray(stats.avg90) ? stats.avg90 : []
    const csv = Array.isArray(product.csv) ? product.csv : []
    const since = now - 90 * DAY_MS
    const series = (index: number) => {
      const values = Array.isArray(csv[index]) ? (csv[index] as unknown[]) : []
      const points: { time: number; value: number }[] = []
      for (let offset = 0; offset + 1 < values.length; offset += 2) {
        const time = numberOrNull(values[offset]),
          number = positive(values[offset + 1])
        if (time !== null && number !== null)
          points.push({ time: (time + 21564000) * 60000, value: number })
      }
      return points.sort((a, b) => a.time - b.time)
    }
    // Keepa 序列只记录变更点；窗口内无变更时保留窗口开始前最后一个价格。
    const windowPrices = (index: number) => {
      const points = series(index)
      const previous = points.filter(point => point.time <= since).at(-1)
      return [
        ...(previous ? [previous] : []),
        ...points.filter(point => point.time > since && point.time <= now),
      ].map(point => point.value / 100)
    }
    const newPrices = windowPrices(1),
      prices = newPrices.length ? newPrices : windowPrices(0)
    const reviews = series(17),
      previousReview = reviews.filter(point => point.time <= since).at(-1)?.value ?? null,
      currentReview =
        reviews.filter(point => point.time <= now).at(-1)?.value ?? positive(current[17])
    const buybox = textOrNull(stats.buyBoxSellerId)
    return {
      asin: textValue(product.asin),
      bsrNow: positive(current[3]),
      bsrAvg90: positive(average[3]),
      drops90: positive(stats.salesRankDrops90),
      offers: positive(current[11]),
      buybox: buybox && buybox !== "-1" && buybox !== "-2" ? buybox : null,
      priceMin90: prices.length ? Math.min(...prices) : null,
      priceMax90: prices.length ? Math.max(...prices) : null,
      priceAvg90: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      reviewVelocity:
        previousReview !== null && currentReview !== null
          ? Math.max(0, currentReview - previousReview) / 3
          : null,
    }
  })
}

export interface CategoryDataUsage {
  totalCalls: number
  callDetail: Record<string, number>
  endpointCalls: Record<string, number>
}

@Injectable()
export class CategoryEvidenceProvider {
  private readonly cache = new Map<string, EvidenceCacheEntry>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async collect(
    userId: number,
    category: CategorySelection,
    site: string,
    usage: CategoryDataUsage = { totalCalls: 0, callDetail: {}, endpointCalls: {} },
    userKeywords: string[] = []
  ): Promise<CategoryEvidence> {
    const months: MonthSample[] = []
    const rows: SampleRow[] = []
    const notices: string[] = []
    const hasSample = false
    const seedKeyword = category.seedKeyword?.trim() || category.name.trim()
    const hasSifKey = Boolean(this.config.get<string>("SIF_API_KEY")?.trim())
    let categoryId: unknown = category.categoryId ?? null
    if (hasSifKey) {
      const searches = [
        ...new Set(
          [category.seedKeyword, category.name, category.parentName].filter(
            (value): value is string => Boolean(value && /[a-z]/i.test(value))
          )
        ),
      ]
      for (const query of categoryId ? [] : searches) {
        try {
          const candidates = asRows(
            await this._sif("category/suggestion", site, { categoryKeyword: query }, usage, true)
          )
          const match = selectCategory(
            candidates,
            query,
            `${category.name} ${category.parentName ?? ""}`
          )
          if (match) {
            categoryId = match.categoryId
            break
          }
        } catch (error) {
          if (!hasSample) throw error
          notices.push("类目词匹配暂不可用，相关指标需补充")
          break
        }
      }
    } else if (!hasSample)
      throw new ServiceUnavailableException("类目数据服务尚未配置，请联系管理员")
    if (!hasSample) {
      if (categoryId === null)
        throw new BadGatewayException("未匹配到类目，请选择更细的类目或调整英文主关键词")
      const keywords = asRows(
        await this._sif(
          "relevanceScreen/keywordByCategory",
          site,
          {
            categoryId,
            topNAsins: 20,
            pageNum: 1,
            pageSize: 100,
          },
          usage
        )
      )
      const frequencies = new Map<string, number>()
      for (const keyword of keywords) {
        const asins = Array.isArray(keyword.topAsin) ? keyword.topAsin : []
        for (const asin of new Set(
          asins
            .map(value => textValue(asObject(value).asin).toUpperCase())
            .filter(value => /^[A-Z0-9]{10}$/.test(value))
        ))
          frequencies.set(asin, (frequencies.get(asin) ?? 0) + 1)
      }
      const asins = [...frequencies]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 300)
        .map(([asin]) => asin)
      let newAsins: string[] = []
      try {
        newAsins = asRows(
          await this._sif(
            "categoryNewReleases",
            site,
            { categoryId, pageNum: 1, pageSize: 50 },
            usage
          )
        )
          .map(row => textValue(row.asin).toUpperCase())
          .filter(asin => /^[A-Z0-9]{10}$/.test(asin))
          .slice(0, 50)
        asins.push(...newAsins.filter(asin => !asins.includes(asin)))
      } catch {
        notices.push("新品补样暂不可用，新品相关指标可能不足")
      }
      for (let index = 0; index < asins.length; index += 100)
        rows.push(
          ...parseSifSample(
            await this._sif(
              "batchAsinDetail",
              site,
              { asins: asins.slice(index, index + 100) },
              usage
            )
          )
        )
      for (const row of rows) row.isNewRelease = newAsins.includes(row.asin)
      if (rows.length < 30)
        throw new BadGatewayException(`有效样本仅 ${rows.length} 条，不足 30 条，暂不能生成报告`)
    }
    let keywords: CategoryKeyword[] = []
    if (hasSifKey) {
      try {
        let headRows: Record<string, unknown>[] = []
        if (categoryId !== null) {
          try {
            headRows = asRows(
              await this._sif(
                "relevanceScreen/keywordByCategory",
                site,
                {
                  categoryId,
                  topNAsins: 1,
                  pageNum: 1,
                  pageSize: 30,
                },
                usage
              )
            )
          } catch {
            notices.push("类目头部词暂不可用，使用主关键词补充指标")
          }
        }
        const heads = [
          ...new Set([
            ...userKeywords,
            ...headRows.map(row => keywordKey(row.keyword)).filter(Boolean),
          ]),
        ].slice(0, 20)
        // 开发文档 §4.6：有样本但类目词未匹配时，仍按主关键词补充切入数据。
        if (!heads.length && seedKeyword) heads.push(seedKeyword)
        if (heads.length) {
          const requests: [string, Record<string, unknown>][] = [
            ["batchKeywordSimpleOverview", {}],
            ["estSearchesHistory", { granularity: "month" }],
            ["keywordCompetitorGroupByMonthly", { last30d: true }],
            ["keywordConversionLast", {}],
            [
              "competePatternFlexibleGroupByMonthly",
              {
                last30d: true,
                pageNum: 1,
                pageSize: 1000,
                sortBy: "totalScoreRatio",
                desc: true,
                maxKeywordAsinCount: 20,
              },
            ],
          ]
          const responses = await Promise.allSettled(
            requests.map(([endpoint, options]) =>
              this._keywordBatch(endpoint, site, heads, options, usage)
            )
          )
          keywords = parseKeywords(
            heads,
            responses.map(result => (result.status === "fulfilled" ? result.value : null))
          )
          for (const keyword of keywords) keyword.is_user = userKeywords.includes(keyword.keyword)
          if (responses.some(result => result.status === "rejected"))
            notices.push("部分关键词指标需补充，可稍后重新分析")
        }
      } catch {
        notices.push("关键词数据暂不可用，相关指标需补充")
      }
    } else notices.push("未匹配到关键词类目，关键词切入数据需补充")
    const sortedRows = [...rows].sort((a, b) => (b.sales ?? -1) - (a.sales ?? -1))
    const history: Record<string, unknown> = {}
    const historyAsins = sortedRows.slice(0, 200).map(row => row.asin)
    for (let index = 0; index < historyAsins.length; index += 10) {
      try {
        Object.assign(
          history,
          asObject(
            await this._sif(
              "asinsHistorySales",
              site,
              { asins: historyAsins.slice(index, index + 10), month: 18 },
              usage
            )
          )
        )
      } catch {
        notices.push("部分月销历史需补充")
      }
    }
    months.push(...parseSalesHistory(history, rows))
    const trends: HeadTrend[] = []
    const endDate = new Date().toISOString().slice(0, 10)
    const startDate = new Date(Date.now() - 90 * DAY_MS).toISOString().slice(0, 10)
    for (const row of sortedRows.slice(0, 20)) {
      try {
        const trend = parseHeadTrend(
          row.asin,
          await this._sif(
            "timeMachine/asinOpTrafficTrend",
            site,
            { asin: row.asin, startDate, endDate },
            usage,
            true,
            { asin: row.asin, windowDays: 90 }
          )
        )
        if (trend) {
          trends.push(trend)
          row.reviewsNew = trend.reviewsNew
          row.sellerCount = trend.sellerCount
        }
      } catch {
        notices.push("部分头部日趋势需补充")
      }
    }
    let keepa: KeepaItem[] = []
    try {
      keepa = await this._keepa(
        site,
        [...rows]
          .sort((a, b) => (b.sales ?? -1) - (a.sales ?? -1))
          .slice(0, 10)
          .map(row => row.asin),
        notices,
        usage
      )
    } catch {
      notices.push("头部 90 天动态暂不可用，相关指标需补充")
    }
    try {
      await this._enrichSellers(site, rows, keepa, usage, notices)
    } catch {
      notices.push("卖家画像暂不可用，相关指标需补充")
    }
    return {
      categoryId: String(categoryId),
      trends,
      newReleaseMerged: rows.filter(row => row.isNewRelease).length,
      source: "sif",
      months,
      rows,
      keywords,
      keepa,
      notices: [...new Set(notices)],
    }
  }

  async resolveKeywords(
    keywords: string[],
    site: string,
    usage: CategoryDataUsage
  ): Promise<KeywordResolution> {
    const merged = new Map<string, CategoryCandidate>()
    const topAsins = new Set<string>()
    const notices: string[] = []
    for (const keyword of keywords) {
      const direct: Record<string, unknown>[] = []
      const votes = new Map<string, CategoryCandidate>()
      try {
        direct.push(
          ...asRows(
            await this._sif("category/suggestion", site, { categoryKeyword: keyword }, usage, true)
          ).slice(0, 3)
        )
      } catch {
        notices.push(`「${keyword}」类目名称匹配暂不可用`)
      }
      try {
        const patterns = asRows(
          await this._sif(
            "competePatternFlexibleGroupByMonthly",
            site,
            {
              keywords: [keyword],
              last30d: true,
              pageNum: 1,
              pageSize: 20,
              sortBy: "totalScoreRatio",
              desc: true,
              maxKeywordAsinCount: 20,
            },
            usage
          )
        )
        const asins = [
          ...new Set(
            patterns
              .map(row => textValue(row.asin ?? asObject(row.asinDetail).asin).toUpperCase())
              .filter(asin => /^[A-Z0-9]{10}$/.test(asin))
          ),
        ].slice(0, 20)
        asins.forEach(asin => topAsins.add(asin))
        const details = asins.length
          ? asRows(await this._sif("batchAsinDetail", site, { asins: asins.slice(0, 10) }, usage))
          : []
        for (const row of details) {
          const seen = new Set<string>()
          for (const rank of asRows(row.bsrList)) {
            const id = textValue(rank.id).split("/").at(-1) ?? ""
            if (!/^\d+$/.test(id) || Number(rank.rank) === -1 || seen.has(id)) continue
            seen.add(id)
            const candidate = votes.get(id) ?? {
              categoryId: id,
              categoryName: textValue(rank.name) || id,
              hits: 0,
              sales: 0,
              kws: [keyword],
              best: 0,
            }
            candidate.hits += 1
            candidate.sales += positive(row.boughtInPastMonth) ?? 0
            votes.set(id, candidate)
          }
        }
      } catch {
        notices.push(`「${keyword}」头部商品反查暂不可用`)
      }
      const candidates = [...votes.values()].sort((a, b) => b.hits - a.hits || b.sales - a.sales)
      for (const item of direct) {
        const id = textValue(item.categoryId)
        if (/^\d+$/.test(id) && !votes.has(id))
          candidates.push({
            categoryId: id,
            categoryName: textValue(item.categoryName) || id,
            hits: 0,
            sales: 0,
            kws: [keyword],
            best: 0,
          })
      }
      candidates.slice(0, 6).forEach((candidate, index) => {
        const existing = merged.get(candidate.categoryId)
        if (existing) {
          existing.kws.push(keyword)
          existing.hits += candidate.hits
          existing.sales += candidate.sales
          existing.best = Math.min(existing.best, index)
        } else merged.set(candidate.categoryId, { ...candidate, best: index })
      })
      if (!candidates.length) notices.push(`「${keyword}」未找到可用类目，请检查拼写或换一个英文词`)
    }
    return {
      candidates: [...merged.values()].sort(
        (a, b) => b.kws.length - a.kws.length || a.best - b.best || b.hits - a.hits
      ),
      topAsins: [...topAsins],
      notices,
    }
  }

  private async _keywordBatch(
    endpoint: string,
    site: string,
    keywords: string[],
    options: Record<string, unknown>,
    usage: CategoryDataUsage
  ): Promise<unknown> {
    const keyOf = (keyword: string) =>
      `word:${site}:${endpoint}:${keywordKey(keyword)}:${canonicalJson(options)}`
    const entries = await Promise.all(keywords.map(keyword => this._restoreCache(keyOf(keyword))))
    const values = new Map(keywords.map((keyword, index) => [keyword, entries[index]?.promise]))
    const missing = keywords.filter(keyword => !values.get(keyword))
    if (missing.length) {
      const payload = { keywords: missing, ...options }
      const data = asRows(await this._sif(endpoint, site, payload, usage))
      // 从旧批次拆出的逐词缓存沿用原过期时间，命中不得续期。
      const batch = await this._restoreCache(this._sifCacheKey(endpoint, site, payload, false))
      const expiresAt = batch?.expiresAt ?? Date.now()
      for (const keyword of missing) {
        const rows = data.filter(row => keywordKey(row.keyword) === keywordKey(keyword))
        await this._storeCache(keyOf(keyword), rows, expiresAt)
        values.set(keyword, Promise.resolve(rows))
      }
    }
    return (await Promise.all(keywords.map(keyword => values.get(keyword)!))).flat()
  }

  private async _enrichSellers(
    site: string,
    rows: SampleRow[],
    products: KeepaItem[],
    usage: CategoryDataUsage,
    notices: string[]
  ) {
    const key = this.config.get<string>("KEEPA_API_KEY")?.trim()
    const ids = [
      ...new Set(products.map(item => item.buybox).filter((id): id is string => Boolean(id))),
    ].slice(0, 10)
    if (!key || !ids.length) return
    const base = this.config
      .get<string>("KEEPA_API_BASE_URL", "https://api.keepa.com")
      .replace(/\/+$/, "")
    const keyOf = (id: string) => `seller:${site}:${id}`
    await Promise.all(ids.map(id => this._restoreCache(keyOf(id))))
    const missing = ids.filter(id => !this.cache.has(keyOf(id)))
    if (missing.length) {
      const quota = await axios.get<{ tokensLeft: number }>(`${base}/token`, {
        params: { key },
        timeout: 35000,
      })
      const requested = missing.slice(
        0,
        Math.max(0, Math.floor(numberOrNull(quota.data.tokensLeft) ?? 0))
      )
      if (requested.length < missing.length) notices.push("卖家画像额度不足，部分卖家信息需补充")
      if (requested.length) {
        const response = await axios.get<unknown>(`${base}/seller`, {
          params: { key, domain: KEEPA_DOMAINS[site], seller: requested.join(",") },
          timeout: 35000,
        })
        if (asObject(response.data).error) throw new Error("卖家画像请求失败")
        this._recordDataCall(usage, "keepa", "seller")
        const sellers = asObject(asObject(response.data).sellers)
        for (const id of requested) if (sellers[id]) await this._storeCache(keyOf(id), sellers[id])
      }
    }
    for (const item of products) {
      if (!item.buybox) continue
      const row = rows.find(row => row.asin === item.asin)
      const cached = this.cache.get(keyOf(item.buybox))
      if (!row || !cached || cached.expiresAt <= Date.now()) continue
      const seller = asObject(await cached.promise)
      const address = Array.isArray(seller.address) ? seller.address : []
      row.sellerId = item.buybox
      row.seller = textValue(seller.sellerName ?? seller.businessName) || item.buybox
      row.sellerCountry =
        seller.shipsFromChina === true ? "CN" : textValue(address.at(-1)).toUpperCase() || null
    }
  }

  private _recordDataCall(usage: CategoryDataUsage, provider: string, endpoint: string): void {
    // 只在真实成功请求的缓存加载器内计数；缓存复用和额度探测不产生调用费用。
    usage.totalCalls += 1
    usage.callDetail[provider] = (usage.callDetail[provider] ?? 0) + 1
    const key = `${provider}:${endpoint}`
    usage.endpointCalls[key] = (usage.endpointCalls[key] ?? 0) + 1
  }

  private _rememberCache(key: string, entry: EvidenceCacheEntry): void {
    for (const [cacheKey, value] of this.cache)
      if (value.expiresAt <= Date.now()) this.cache.delete(cacheKey)
    if (!this.cache.has(key) && this.cache.size >= 1000)
      this.cache.delete(this.cache.keys().next().value)
    this.cache.set(key, entry)
  }

  private async _restoreCache(key: string): Promise<EvidenceCacheEntry | undefined> {
    const existing = this.cache.get(key)
    if (existing && existing.expiresAt > Date.now()) return existing
    this.cache.delete(key)
    if (!this.prisma.categoryAnalysisCache) return
    const cached = await this.prisma.categoryAnalysisCache.findUnique({
      where: { cacheKey: createHash("sha256").update(key).digest("hex") },
    })
    if (cached && cached.expiresAt.getTime() > Date.now()) {
      const entry = {
        expiresAt: cached.expiresAt.getTime(),
        promise: Promise.resolve(cached.payload),
      }
      this._rememberCache(key, entry)
      return entry
    }
  }

  private async _storeCache(
    key: string,
    payload: unknown,
    expiresAt = this._cacheExpiresAt(key)
  ): Promise<void> {
    this._rememberCache(key, { expiresAt, promise: Promise.resolve(payload) })
    if (!this.prisma.categoryAnalysisCache) return
    const cacheKey = createHash("sha256").update(key).digest("hex")
    const data = {
      payload:
        payload == null
          ? Prisma.JsonNull
          : (JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue),
      expiresAt: new Date(expiresAt),
    }
    await this.prisma.categoryAnalysisCache.upsert({
      where: { cacheKey },
      create: { cacheKey, ...data },
      update: data,
    })
  }

  private _cacheExpiresAt(key: string): number {
    // 本次仅调整 SIF；Keepa 保持原 UTC 当天有效。
    return key.startsWith("sif:") || key.startsWith("word:")
      ? Date.now() + SIF_CACHE_TTL_MS
      : Date.parse(new Date().toISOString().slice(0, 10)) + DAY_MS
  }

  private async _cached<T>(
    key: string,
    load: () => Promise<T>,
    shouldCache: (value: T) => boolean = () => true
  ): Promise<T> {
    const pending = this.inFlight.get(key)
    if (pending) return pending as Promise<T>
    const promise = (async () => {
      const cached = await this._restoreCache(key)
      if (cached) return cached.promise as Promise<T>
      const value = await load()
      if (shouldCache(value)) await this._storeCache(key, value)
      return value
    })()
      .catch(error => {
        this.cache.delete(key)
        throw error
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private _sifCacheKey(
    endpoint: string,
    site: string,
    payload: Record<string, unknown>,
    isGet: boolean
  ): string {
    const normalized = { ...payload }
    for (const name of ["asins", "keywords"]) {
      const values = normalized[name]
      if (Array.isArray(values)) normalized[name] = [...(values as string[])].sort()
    }
    return `sif:v2:${site}:${isGet ? "GET" : "POST"}:${endpoint}:${canonicalJson(normalized)}`
  }

  private _sif(
    endpoint: string,
    site: string,
    payload: Record<string, unknown>,
    usage: CategoryDataUsage,
    isGet = false,
    cachePayload = payload
  ): Promise<unknown> {
    return this._cached(this._sifCacheKey(endpoint, site, cachePayload, isGet), async () => {
      const key = this.config.get<string>("SIF_API_KEY")?.trim()
      if (!key) throw new ServiceUnavailableException("类目数据服务尚未配置")
      try {
        const response = await axios.request<{ code: number; data: unknown }>({
          url: `${this.config.get<string>("SIF_API_BASE_URL", "https://www.sif.com").replace(/\/+$/, "")}/api/search/external/v2/${endpoint}`,
          method: isGet ? "GET" : "POST",
          headers: { authorization: key },
          params: { country: site, ...(isGet ? payload : {}) },
          data: isGet ? undefined : payload,
          timeout: 35000,
        })
        if (response.data.code !== 1) {
          const labels: Record<number, string> = {
            [-1]: "数据查询参数异常",
            [-20]: "数据服务配额已用完",
            [-22]: "数据服务请求频率超限，请稍后重试",
            [-25]: "数据服务尚未分配配额",
          }
          throw new BadGatewayException(labels[response.data.code] ?? "数据服务暂不可用")
        }
        this._recordDataCall(usage, "sif", endpoint)
        return response.data.data
      } catch (error) {
        if (error instanceof BadGatewayException) throw error
        throw new BadGatewayException("类目数据请求失败，请稍后重试")
      }
    })
  }
  private async _keepa(
    site: string,
    asins: string[],
    notices: string[],
    usage: CategoryDataUsage
  ): Promise<KeepaItem[]> {
    const key = this.config.get<string>("KEEPA_API_KEY")?.trim()
    if (!key || !asins.length) return []
    const base = this.config
      .get<string>("KEEPA_API_BASE_URL", "https://api.keepa.com")
      .replace(/\/+$/, "")
    return this._cached(
      `keepa:${site}:${asins.join(",")}`,
      async () => {
        const quota = await axios.get<{ tokensLeft: number; refillIn?: number }>(`${base}/token`, {
          params: { key },
          timeout: 35000,
        })
        const tokens = numberOrNull(quota.data.tokensLeft)
        if (tokens === null || tokens <= 0) {
          notices.push(
            `头部动态额度不足，约 ${Math.max(1, Math.ceil((quota.data.refillIn ?? 60000) / 60000))} 分钟后恢复`
          )
          return []
        }
        const requested = asins.slice(0, Math.min(10, Math.floor(tokens / 3)))
        if (!requested.length) {
          notices.push("卖家画像额度不足，相关指标需补充")
          return []
        }
        if (requested.length < asins.length)
          notices.push(`头部动态仅覆盖 ${requested.length}/${asins.length} 个商品，其余需补充`)
        const response = await axios.get<unknown>(`${base}/product`, {
          params: {
            key,
            domain: KEEPA_DOMAINS[site],
            asin: requested.join(","),
            stats: 90,
            history: 1,
            buybox: 1,
          },
          timeout: 35000,
        })
        if (asObject(response.data).error) throw new Error("头部动态请求失败")
        this._recordDataCall(usage, "keepa", "product")
        return parseKeepaProducts(response.data)
      },
      items => items.length > 0 && items.length === asins.length
    )
  }
}
