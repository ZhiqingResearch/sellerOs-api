import type {
  AssembledCompetitorAnalysis,
  CompetitorEvidenceBundle,
} from "./competitor-analysis.types"
import {
  KEEPA_CSV,
  keepaBuyBoxHistory,
  keepaCouponSeries,
  keepaCsvSeries,
  keepaCurrentBuyBoxSeller,
  keepaCurrentCoupon,
  keepaCurrentStock,
  keepaFirstInRange,
  keepaLatestDate,
  keepaListedDays,
  keepaMonthlySoldSeries,
  keepaProduct,
  keepaSellers,
  keepaStockSeries,
  keepaSuggestedPrice,
  keepaValueAsOf,
  type KeepaSeriesPoint,
} from "./competitor-keepa"

type JsonRecord = Record<string, unknown>

interface AdCampaignCell {
  keywords: Set<string>
  score: number
  histories: JsonRecord[]
}

const KEYWORD_TABLE_SIZE = 10
const TIMELINE_ROW_LIMIT = 12
const SERIES_DAY_LIMIT = 90
const SOP_MIN_COLUMNS = 14
const SOP_MAX_COLUMNS = 40
const DAY_MS = 86_400_000
const ATTRIBUTION_WINDOW_DAYS = 3

export function assembleCompetitorAnalysis(
  evidence: CompetitorEvidenceBundle
): AssembledCompetitorAnalysis {
  const sif = asRecord(evidence.sif)
  const keepa = asRecord(evidence.keepa)
  const profiles = buildProfiles(evidence.asins, sif)
  const profileByAsin = new Map(profiles.map(profile => [String(profile.asin), profile]))

  return {
    profiles,
    trafficBoards: evidence.asins.map(asin => buildTrafficBoard(asin, sif)),
    pricePromoBoards: evidence.asins.map(asin =>
      buildPricePromoBoard(asin, sif, keepa, profileByAsin.get(asin), keepaSourceState(evidence))
    ),
  }
}

function buildProfiles(asins: string[], sif: JsonRecord): JsonRecord[] {
  const details = rowsOf(sif.profile)
  const prices = rowsOf(sif.price)
  const monthlySales = asRecord(sif.monthlySales)
  const detailByAsin = mapRecords(details, row => upperString(row.requestAsin ?? row.asin))
  const priceByAsin = mapRecords(prices, row => upperString(row.asin))

  return asins.map(asin => {
    const detail = detailByAsin.get(asin)
    const price = priceByAsin.get(asin)
    const sales = asRecord(monthlySales[asin] ?? monthlySales[asin.toLowerCase()])
    const salesTrend = Object.entries(sales)
      .filter(([month, value]) => /^\d{4}-\d{2}$/.test(month) && nullableNumber(value) !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, value]) => ({ month, sales: numberValue(value) }))
    const bsrList = arrayRecords(detail?.bsrList)
    const mainBsr = bsrList.length
      ? {
          name: stringValue(bsrList[0].name),
          rank: numberValue(bsrList[0].rank, -1),
        }
      : null
    const priorityTags = stringArray(price?.pricePriorityTags)
    const exceptionTags = stringArray(price?.priceExceptionTags)

    return {
      asin,
      found: Boolean(detail),
      title: stringValue(detail?.title),
      img: stringValue(detail?.img),
      brand: stringValue(detail?.brand),
      price: numberValue(price?.currentPrice ?? detail?.price),
      score: numberValue(detail?.score),
      ratingNum: numberValue(detail?.ratingNum),
      boughtInPastMonth: numberValue(detail?.boughtInPastMonth),
      mainBsr,
      listedDays: daysSince(stringValue(detail?.firstAvailableDay ?? price?.listedDate)),
      firstAvailableDay: stringValue(detail?.firstAvailableDay ?? price?.listedDate),
      variationNum: numberValue(detail?.variationNum),
      specs: arrayRecords(detail?.featureList)
        .map(item => ({ code: stringValue(item.code), value: stringValue(item.value) }))
        .filter(item => item.code || item.value),
      bullets: stringArray(detail?.featureDescriptions),
      salesTrend,
      priorityTags,
      exceptionTags,
      reviewGrowth30d: null,
      fieldSources: {
        title: "sif",
        img: "sif",
        brand: "sif",
        price: "sif",
        score: "sif",
        ratingNum: "sif",
        boughtInPastMonth: "sif",
        mainBsr: "sif",
        listedDays: "sif",
        variationNum: "sif",
        specs: "sif",
        salesTrend: "sif",
        tags: "sif",
      },
    }
  })
}

function buildTrafficBoard(asin: string, sif: JsonRecord): JsonRecord {
  const summaryRow = rowsOf(sif.trafficSummary).find(row => upperString(row.asin) === asin)
  const reverseRows = rowsOf(sif.keywords).filter(row => upperString(row.asin) === asin)
  const adData = asRecord(asRecord(sif.adKeywords)[asin])
  const adRows = rowsOf(adData)
  const competeRows = rowsOf(asRecord(sif.competePatterns)[asin])
  const reverseByKeyword = mapRecords(reverseRows, row => normalizedKeyword(row.keyword))
  const adByKeyword = mapRecords(adRows, row => normalizedKeyword(row.keyword))
  const competeByKeyword = mapRecords(competeRows, row => normalizedKeyword(row.keyword))
  const orderedKeywords = [
    ...reverseRows.map(row => normalizedKeyword(row.keyword)),
    ...adRows.map(row => normalizedKeyword(row.keyword)),
  ].filter((keyword, index, all) => keyword && all.indexOf(keyword) === index)
  const totalListingAdScore = adRows.reduce(
    (sum, row) => sum + Math.max(0, numberValue(row.kwSpScoreRatio ?? row.spScoreRatio)),
    0
  )
  const keywords = orderedKeywords.slice(0, KEYWORD_TABLE_SIZE).map(keyword => {
    const reverse = reverseByKeyword.get(keyword)
    const ad = adByKeyword.get(keyword)
    const compete = competeByKeyword.get(keyword)
    const variants = arrayRecords(ad?.variants)
    const variant = variants.find(item => upperString(item.asin) === asin) ?? variants[0]
    const history = arrayRecords(variant?.spHistory)
    const latestRank = nullableNumber(history.at(-1)?.rank)
    const previousRank = nullableNumber(history.at(-2)?.rank)

    return {
      keyword: stringValue(reverse?.keyword ?? ad?.keyword ?? keyword),
      searchVolume: numberValue(reverse?.searchVolume ?? ad?.searchVolume),
      totalScoreRatio: nullableNumber(compete?.totalScoreRatio),
      adScoreRatio: percentageValue(ad?.spScoreRatio ?? compete?.spScoreRatio),
      spRank: spRankFromHistory(history) ?? rankFromSequence(reverse?.spPositionSeq, true),
      naturalRank: rankFromSequence(reverse?.naturalPositionSeq, false),
      marketConversionRate:
        nullableNumber(reverse?.conversionShared) === null
          ? null
          : numberValue(reverse?.conversionShared) / 100,
      listingAdScoreRatio:
        totalListingAdScore > 0
          ? numberValue(ad?.kwSpScoreRatio ?? ad?.spScoreRatio) / totalListingAdScore
          : 0,
      adRatioRising:
        latestRank !== null && previousRank !== null ? latestRank < previousRank : false,
      fieldSources: {},
    }
  })
  const naturalScore = numberValue(summaryRow?.naturalScore)
  const adScore = numberValue(summaryRow?.adScore)
  const scoreTotal = naturalScore + adScore
  const totalScore = numberValue(summaryRow?.totalScore)
  const totalScorePrevious = numberValue(summaryRow?.totalScorePrev)
  const adScorePrevious = numberValue(summaryRow?.adScorePrev)
  const campaigns = buildAdCampaigns(adRows)
  const groups = buildAdGroups(keywords)

  return {
    asin,
    found: Boolean(summaryRow || reverseRows.length || adRows.length),
    summary: {
      asin,
      found: Boolean(summaryRow || reverseRows.length || adRows.length),
      totalScore,
      totalScoreChg: ratioChange(totalScore, totalScorePrevious),
      naturalRatio: scoreTotal > 0 ? naturalScore / scoreTotal : 0,
      adRatio: scoreTotal > 0 ? adScore / scoreTotal : 0,
      adKeywordNum: numberValue(summaryRow?.adKeywordNum ?? adData.total),
      campaignCnt: numberValue(adData.totalCampaignCnt),
      spKeywordNum: numberValue(summaryRow?.spKeywordNum),
      sbKeywordNum: numberValue(summaryRow?.sbKeywordNum),
      sbvKeywordNum: numberValue(summaryRow?.sbvKeywordNum),
      naturalKeywordNumIn: numberValue(summaryRow?.naturalKeywordNumIn),
      naturalKeywordNumOut: numberValue(summaryRow?.naturalKeywordNumOut),
      adKeywordNumIn: numberValue(summaryRow?.adKeywordNumIn),
      adKeywordNumOut: numberValue(summaryRow?.adKeywordNumOut),
      adScoreChg: ratioChange(adScore, adScorePrevious),
    },
    keywords,
    adDetail: {
      asin,
      keywordCount: keywords.length,
      campaignCountEstimate: numberValue(adData.totalCampaignCnt),
      adGroupCountEstimate: numberValue(adData.totalAdCnt),
      primaryTargeting: keywords.length >= 5 ? "手动广告为主" : "样本不足，不作推算",
      alternativeTargeting: keywords.length >= 5 ? "自动广告补充" : null,
      confidence: keywords.length >= 5 ? "medium" : "insufficient",
      notice: "投放类型、匹配模式与词根结构为规则推测，非广告后台真值",
      groups,
      campaigns,
      keywords: keywords.filter(row => numberValue(row.adScoreRatio) > 0 || row.spRank),
      keywordCards: buildKeywordCards(adRows, asin, totalListingAdScore),
    },
  }
}

function buildPricePromoBoard(
  asin: string,
  sif: JsonRecord,
  keepaEvidence: JsonRecord,
  profile: JsonRecord | undefined,
  keepaState: string
): JsonRecord {
  const trend = asRecord(asRecord(sif.trafficTrends)[asin])
  const dates = stringArray(trend.dates)
  const keepaEnvelope = asRecord(keepaEvidence[asin])
  const keepa = keepaProduct(keepaEnvelope, asin)
  const sellers = keepaSellers(keepaEnvelope)
  const priceRows = rowsOf(sif.price)
  const priceRow = priceRows.find(row => upperString(row.asin) === asin)
  const adRows = rowsOf(asRecord(asRecord(sif.adKeywords)[asin]))
  const keywordTrendRows = rowsOf(sif.keywordTrends).filter(row => upperString(row.asin) === asin)
  const profileListedDays = nullableNumber(profile?.listedDays)
  const listedDays = profileListedDays ?? keepaListedDays(keepa)
  const weeks = buildSopWeeks(trend, dates, keepa, listedDays)
  const keepaSignalAvailable = hasKeepaSignalHistory(keepa)
  const timeline = keepaSignalAvailable
    ? buildKeepaTimeline(keepa, trend, dates, keywordTrendRows)
    : buildSifTimeline(trend, dates)
  const series = buildPricePromoSeries(keepa, trend, dates, keepaState)
  const channels = arrayRecords(series.channels)
  const keepaBsrPoints = keepaCsvSeries(keepa, KEEPA_CSV.SALES, "raw")
  const bsrPoints = keepaBsrPoints.length
    ? keepaBsrPoints.slice(-SERIES_DAY_LIMIT)
    : arrayRecords(series.salesRank)
  const bsrValues = bsrPoints.map(point => numberValue(point.value))
  const keepaReviews = keepaCsvSeries(keepa, KEEPA_CSV.COUNT_REVIEWS, "raw")
  const reviewValues = keepaSignalAvailable
    ? keepaReviews.map(point => point.value)
    : numericSeries(trend.review)
  const metricEndDate = keepaLatestDate(keepa) ?? dates.at(-1) ?? ""
  const keepaBsrFrom = metricEndDate
    ? keepaValueAsOf(keepaBsrPoints, addDays(metricEndDate, -29))
    : null
  const keepaBsrTo = metricEndDate ? keepaValueAsOf(keepaBsrPoints, metricEndDate) : null
  const keepaReviewFrom = metricEndDate
    ? keepaValueAsOf(keepaReviews, addDays(metricEndDate, -29))
    : null
  const keepaReviewTo = metricEndDate ? keepaValueAsOf(keepaReviews, metricEndDate) : null
  const currentPrice = currentBoardPrice(keepa, trend, priceRow, profile)
  const topKeywords = adRows
    .slice()
    .sort(
      (left, right) =>
        numberValue(right.kwSpScoreRatio ?? right.spScoreRatio) -
        numberValue(left.kwSpScoreRatio ?? left.spScoreRatio)
    )
    .map(row => stringValue(row.keyword))
    .filter(Boolean)
    .slice(0, 3)
  const metrics = {
    currentPrice,
    priceVolatility: priceVolatility(channels),
    promoCount30d: hasKeepaPromotionHistory(keepa)
      ? countKeepaPromotions(keepa, series.endDate)
      : countPromotions(trend, dates),
    bsrFrom: keepaBsrFrom ?? bsrValues[0] ?? null,
    bsrTo: keepaBsrTo ?? bsrValues.at(-1) ?? null,
    bsrDelta:
      keepaBsrFrom !== null && keepaBsrTo !== null
        ? keepaBsrFrom - keepaBsrTo
        : bsrValues.length >= 2
          ? numberValue(bsrValues[0]) - numberValue(bsrValues.at(-1))
          : null,
    reviewGrowth30d:
      keepaReviewFrom !== null && keepaReviewTo !== null
        ? keepaReviewTo - keepaReviewFrom
        : reviewValues.length >= 2
          ? (lastNumber(reviewValues.slice(-30)) ?? 0) -
            (reviewValues.at(-30) ?? reviewValues[0] ?? 0)
          : null,
    topKeywords,
    fieldSources: {
      currentPrice: keepaCurrentPrice(keepa) !== null ? "keepa" : "sif",
      priceVolatility: series.source,
      promoCount30d: hasKeepaPromotionHistory(keepa) ? "keepa" : "sif",
      bsr: keepaBsrPoints.length ? "keepa" : "sif",
      reviewGrowth30d: keepaReviews.length ? "keepa" : "sif",
    },
  }
  const sop = buildSop(asin, weeks, listedDays, {
    listedDaysSource: profileListedDays !== null ? "sif" : listedDays !== null ? "keepa" : null,
    suggestedPrice: keepaSuggestedPrice(keepa),
  })

  return {
    asin,
    found: dates.length > 0 || Boolean(priceRow) || Boolean(keepa),
    currentPrice,
    buyBoxSeller: keepaCurrentBuyBoxSeller(keepa, sellers, stringValue(series.startDate)),
    timeline,
    timelineSource: keepaSignalAvailable ? "keepa" : "sif",
    series,
    metrics,
    verdict: buildVerdict(metrics, timeline, keepaSignalAvailable ? "keepa" : "sif"),
    verdictTags: stringArray(priceRow?.pricePriorityTags),
    coldStartNote:
      listedDays !== null && listedDays <= 90 && numberValue(profile?.ratingNum) > 0
        ? {
            text: "上架初期已出现评价与销量信号，疑似存在冷启动引流动作。",
            disclaimer: "自然位与评价增长不能直接证明测评或补单，需结合广告后台人工复核。",
            conf: "低",
          }
        : null,
    sop,
  }
}

function buildSopWeeks(
  trend: JsonRecord,
  dates: string[],
  keepa: JsonRecord | null,
  listedDays: number | null
): JsonRecord[] {
  const endDate = [dates.at(-1), keepaLatestDate(keepa)]
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1)
  if (!endDate) return []
  const spanDays = Math.max(SOP_MIN_COLUMNS, listedDays ?? 84)
  const bucketDays =
    [1, 2, 3, 7, 14, 30].find(candidate => Math.ceil(spanDays / candidate) <= SOP_MAX_COLUMNS) ?? 30
  const count = Math.min(
    SOP_MAX_COLUMNS,
    Math.max(SOP_MIN_COLUMNS, Math.ceil(spanDays / bucketDays))
  )
  const sifDateIndex = new Map(dates.map((date, index) => [date, index]))
  const keepaReviews = keepaCsvSeries(keepa, KEEPA_CSV.COUNT_REVIEWS, "raw")
  const keepaStars = keepaCsvSeries(keepa, KEEPA_CSV.RATING, "raw")
  const keepaBsr = keepaCsvSeries(keepa, KEEPA_CSV.SALES, "raw")
  const keepaBuyBox = preferredKeepaPriceSeries(keepa)
  const keepaListPrice = keepaCsvSeries(keepa, KEEPA_CSV.LISTPRICE, "price")
  const keepaLightning = keepaCsvSeries(keepa, KEEPA_CSV.LIGHTNING_DEAL, "price")
  const keepaOffers = keepaCsvSeries(keepa, KEEPA_CSV.COUNT_NEW, "raw")
  const keepaCoupons = keepaCouponSeries(keepa)
  const keepaSold = keepaMonthlySoldSeries(keepa)
  const keepaStock = keepaStockSeries(keepa)
  const weeks: JsonRecord[] = []
  for (let column = 0; column < count; column += 1) {
    const toDate = addDays(endDate, -(count - column - 1) * bucketDays)
    const fromDate = addDays(toDate, -(bucketDays - 1))
    const from = sifIndexOnOrAfter(dates, fromDate)
    const to = sifIndexAfter(dates, toDate)
    const currentCampaigns = sumRange(trend.campaign, from, to)
    const currentGroups = sumRange(trend.ad, from, to)
    const titleChanged = hasValueInRange(trend.title, from, to)
    const imgChanged = hasValueInRange(trend.img, from, to)
    const price = sourcedValue(
      keepaValueAsOf(keepaBuyBox, toDate),
      lastPositiveValueOnOrBefore(trend.buyboxPrice, dates, sifDateIndex, toDate)
    )
    const bsr = sourcedValue(
      keepaValueAsOf(keepaBsr, toDate),
      lastValueOnOrBefore(trend.bsr, dates, sifDateIndex, toDate)
    )
    const review = sourcedValue(
      keepaValueAsOf(keepaReviews, toDate),
      lastValueOnOrBefore(trend.review, dates, sifDateIndex, toDate)
    )
    const keepaStar = keepaValueAsOf(keepaStars, toDate)
    const star = sourcedValue(
      keepaStar === null ? null : keepaStar / 10,
      lastValueOnOrBefore(trend.star, dates, sifDateIndex, toDate)
    )
    const coupon = sourcedValue(
      keepaFirstInRange(keepaCoupons, fromDate, toDate),
      firstValueInDateRange(trend.couponInfo, dates, fromDate, toDate)
    )
    const currentCoupon = column === count - 1 ? keepaCurrentCoupon(keepa) : null
    const couponValue = coupon.value ?? currentCoupon
    const couponSource = coupon.source ?? (currentCoupon !== null ? "keepa" : undefined)
    const lightning = sourcedValue(
      keepaFirstInRange(keepaLightning, fromDate, toDate),
      firstPositiveValueInDateRange(trend.ldPrice, dates, fromDate, toDate)
    )
    const offerCount = sourcedValue(
      keepaValueAsOf(keepaOffers, toDate),
      lastValueOnOrBefore(trend.seller, dates, sifDateIndex, toDate)
    )
    const bought = sourcedValue(
      keepaValueAsOf(keepaSold, toDate) ??
        (column === count - 1 ? nullableNumber(keepa?.monthlySold) : null),
      lastValueOnOrBefore(trend.bought, dates, sifDateIndex, toDate)
    )
    const stockValue =
      keepaValueAsOf(keepaStock, toDate) ?? (column === count - 1 ? keepaCurrentStock(keepa) : null)
    weeks.push({
      key: column === count - 1 ? "D0" : `D-${(count - column - 1) * bucketDays}`,
      startDate: fromDate,
      bucketDays,
      bought: bought.value,
      weeklySales: null,
      bsr: bsr.value,
      review: review.value,
      star: star.value,
      price: price.value,
      listPrice: keepaValueAsOf(keepaListPrice, toDate),
      coupon: couponValue,
      lightning: lightning.value,
      deal: firstPositiveValueInDateRange(trend.dealPrice, dates, fromDate, toDate),
      adScore: lastValueOnOrBefore(trend.adScore, dates, sifDateIndex, toDate),
      campaignsAdded: Math.max(0, currentCampaigns),
      adGroupsAdded: Math.max(0, currentGroups),
      listingChanged: titleChanged || imgChanged,
      titleChanged,
      imgChanged,
      seller: lastValueOnOrBefore(trend.seller, dates, sifDateIndex, toDate),
      offerCount: offerCount.value,
      stock: stockValue,
      sources: {
        bought: bought.source,
        bsr: bsr.source,
        review: review.source,
        star: star.source,
        price: price.source,
        listPrice: keepaValueAsOf(keepaListPrice, toDate) !== null ? "keepa" : undefined,
        coupon: couponSource,
        lightning: lightning.source,
        deal: "sif",
        adScore: "sif",
        campaignsAdded: "sif",
        adGroupsAdded: "sif",
        titleChanged: "sif",
        imgChanged: "sif",
        seller: "sif",
        offerCount: offerCount.source,
        stock: stockValue !== null ? "keepa" : undefined,
      },
    })
  }
  return weeks
}

function buildSop(
  asin: string,
  weeks: JsonRecord[],
  listedDays: number | null,
  options: { listedDaysSource: string | null; suggestedPrice: number | null }
): JsonRecord {
  const bucketDays = numberValue(weeks[0]?.bucketDays, 7)
  const salesTrendPct = periodTrend(
    weeks.map(week => nullableNumber(week.bought)),
    4
  )
  const bsrTrendPct = periodTrend(
    weeks.map(week => nullableNumber(week.bsr)),
    4
  )
  const stage = inferStage(listedDays, salesTrendPct, bsrTrendPct)
  const reviewDeltas = weeks.map((week, index) => {
    const current = nullableNumber(week.review)
    const previous = nullableNumber(weeks[index - 1]?.review)
    return current !== null && previous !== null ? Math.max(0, current - previous) : 0
  })
  const row = (
    key: string,
    label: string,
    truthLevel: string,
    selector: (
      week: JsonRecord,
      index: number
    ) => { active: boolean; label?: string; source?: string },
    summary: string,
    extras: JsonRecord = {}
  ): JsonRecord => {
    const cells = weeks.map((week, index) => {
      const cell = selector(week, index)
      return { ...cell, source: cell.active ? cell.source : undefined }
    })
    return {
      key,
      label,
      truthLevel,
      cells,
      summary,
      sources: [...new Set(cells.map(cell => cell.source).filter(Boolean))],
      ...extras,
    }
  }
  const promoCount = weeks.filter(
    week =>
      numberValue(week.coupon) !== 0 ||
      numberValue(week.lightning) > 0 ||
      numberValue(week.deal) > 0
  ).length
  const lastPrice = nullableNumber(weeks.at(-1)?.price)
  const rows = [
    row(
      "coldStart",
      "冷启动",
      listedDays !== null && listedDays <= 84 ? "inference" : "unavailable",
      (week, index) => ({
        active:
          listedDays !== null &&
          listedDays <= 84 &&
          (reviewDeltas[index] > 0 || numberValue(week.bought) > 0),
        label:
          reviewDeltas[index] > 0 ? "首评/增评" : numberValue(week.bought) > 0 ? "起量" : undefined,
        source: sourceOfWeek(week, reviewDeltas[index] > 0 ? "review" : "bought"),
      }),
      listedDays !== null && listedDays <= 84
        ? "根据评价和销量信号推测冷启动窗口。"
        : "上架初期不在当前窗口内。"
    ),
    row(
      "listing",
      "Listing 迭代",
      "truth",
      week => ({
        active: week.listingChanged === true,
        label:
          week.titleChanged && week.imgChanged
            ? "标题+主图"
            : week.titleChanged
              ? "改标题"
              : week.imgChanged
                ? "改主图"
                : undefined,
        source: "sif",
      }),
      "标题和主图变更来自 SIF 运营轨迹。"
    ),
    row(
      "reviews",
      "评价获取",
      weeks.some(week => nullableNumber(week.review) !== null) ? "truth" : "unavailable",
      (_week, index) => ({
        active: reviewDeltas[index] > 0,
        label: reviewDeltas[index] > 0 ? `+${reviewDeltas[index]}` : undefined,
        source: sourceOfWeek(weeks[index], "review"),
      }),
      `窗口内评论累计增加 ${reviewDeltas.reduce((sum, value) => sum + value, 0)}。`
    ),
    row(
      "rating",
      "评分变化",
      weeks.some(week => nullableNumber(week.star) !== null) ? "truth" : "unavailable",
      (week, index) => {
        const current = nullableNumber(week.star)
        const previous = nullableNumber(weeks[index - 1]?.star)
        const delta = current !== null && previous !== null ? current - previous : 0
        return {
          active: Math.abs(delta) >= 0.05,
          label:
            Math.abs(delta) >= 0.05
              ? `${delta > 0 ? "↑" : "↓"}${Math.abs(delta).toFixed(1)}`
              : undefined,
          source: sourceOfWeek(week, "star"),
        }
      },
      "评分变化为客观序列信号。"
    ),
    row(
      "pricePromo",
      "价格",
      lastPrice !== null ? "truth" : "unavailable",
      (week, index) => {
        const current = nullableNumber(week.price)
        const previous = nullableNumber(weeks[index - 1]?.price)
        return {
          active: current !== null && previous !== null && current !== previous,
          label:
            current !== null && previous !== null && current !== previous
              ? current < previous
                ? "降价"
                : "涨价"
              : undefined,
          source: sourceOfWeek(week, "price"),
        }
      },
      "成交价变化为接口客观信号。",
      {
        suggestedPrice:
          options.suggestedPrice !== null
            ? `$${options.suggestedPrice.toFixed(2)}`
            : lastPrice === null
              ? null
              : `$${lastPrice.toFixed(2)}`,
        suggestedPriceSource:
          options.suggestedPrice !== null
            ? "keepa"
            : lastPrice === null
              ? null
              : sourceOfWeek(weeks.at(-1), "price"),
      }
    ),
    row(
      "promo",
      "促销",
      "truth",
      week => ({
        active:
          numberValue(week.coupon) !== 0 ||
          numberValue(week.lightning) > 0 ||
          numberValue(week.deal) > 0,
        label:
          numberValue(week.lightning) > 0
            ? "闪购"
            : numberValue(week.coupon) !== 0
              ? couponLabel(numberValue(week.coupon))
              : numberValue(week.deal) > 0
                ? "Deal"
                : undefined,
        source:
          numberValue(week.lightning) > 0
            ? sourceOfWeek(week, "lightning")
            : numberValue(week.coupon) !== 0
              ? sourceOfWeek(week, "coupon")
              : sourceOfWeek(week, "deal"),
      }),
      `窗口内 ${promoCount} 格出现券、闪购或 Deal。`
    ),
    row(
      "advertising",
      "广告投放",
      "inference",
      week => ({
        active:
          numberValue(week.adScore) > 0 ||
          numberValue(week.campaignsAdded) > 0 ||
          numberValue(week.adGroupsAdded) > 0,
        label:
          numberValue(week.campaignsAdded) > 0 || numberValue(week.adGroupsAdded) > 0
            ? "扩量"
            : numberValue(week.adScore) > 0
              ? "在投"
              : undefined,
        source: "sif",
      }),
      "根据广告得分与活动/广告组变化推测投放节奏。"
    ),
    row(
      "keywordHold",
      "关键词守位",
      "inference",
      week => ({
        active: numberValue(week.adScore) > 0 && numberValue(week.bsr) > 0,
        label: numberValue(week.adScore) > 0 ? "守位" : undefined,
        source: "sif",
      }),
      "广告持续且 BSR 有记录时标记为关键词守位窗口。"
    ),
    row(
      "inventory",
      "库存/Offer",
      weeks.some(week => nullableNumber(week.stock) !== null)
        ? "truth"
        : weeks.some(week => nullableNumber(week.offerCount) !== null)
          ? "inference"
          : "unavailable",
      (week, index) => {
        const stock = nullableNumber(week.stock)
        const previousStock = nullableNumber(weeks[index - 1]?.stock)
        const offerCount = nullableNumber(week.offerCount)
        const previousOfferCount = nullableNumber(weeks[index - 1]?.offerCount)
        const stockChanged = index > 0 && stock !== null && stock !== previousStock
        const offerChanged = index > 0 && offerCount !== null && offerCount !== previousOfferCount
        return {
          active: stockChanged || offerChanged,
          label: stockChanged ? `库存 ${stock}` : offerChanged ? `Offer ${offerCount}` : undefined,
          source: stockChanged ? sourceOfWeek(week, "stock") : sourceOfWeek(week, "offerCount"),
        }
      },
      "Keepa 可见库存优先；无库存时以 Offer 数变化作为代理。",
      {
        inventory: inventoryLabel(weeks.at(-1)),
        inventorySource:
          nullableNumber(weeks.at(-1)?.stock) !== null
            ? sourceOfWeek(weeks.at(-1), "stock")
            : sourceOfWeek(weeks.at(-1), "offerCount"),
      }
    ),
    row(
      "stage",
      "当前阶段",
      "inference",
      (_week, index) => ({
        active: index >= Math.max(0, weeks.length - 2),
        label: index >= Math.max(0, weeks.length - 2) ? stage : undefined,
        source: sourceOfWeek(weeks[index], "bsr"),
      }),
      `销量趋势 ${formatPercent(salesTrendPct)}，BSR 趋势 ${formatPercent(bsrTrendPct)}，推测处于${stage}。`
    ),
  ]

  return {
    asin,
    stage,
    grain: bucketDays < 7 ? "day" : "week",
    bucketDays,
    weeks,
    rows,
    listedDays,
    listedDaysSource: options.listedDaysSource,
    earlyStageNote:
      listedDays !== null && listedDays <= 84
        ? null
        : "上架初期数据不在窗口内（方法论推测，非窗口数据）",
    salesTrendPct,
    bsrTrendPct,
  }
}

interface TimelineEvent {
  date: string
  priceSignal: JsonRecord | null
  extraSignals: string[]
}

function buildKeepaTimeline(
  keepa: JsonRecord | null,
  trend: JsonRecord,
  dates: string[],
  keywordTrendRows: JsonRecord[]
): JsonRecord[] {
  const events = new Map<string, TimelineEvent>()
  const priceSeries = preferredKeepaPriceSeries(keepa)
  const bsrSeries = keepaCsvSeries(keepa, KEEPA_CSV.SALES, "raw")
  const reviewSeries = keepaCsvSeries(keepa, KEEPA_CSV.COUNT_REVIEWS, "raw")
  const ratingSeries = keepaCsvSeries(keepa, KEEPA_CSV.RATING, "raw")
  const offerSeries = keepaCsvSeries(keepa, KEEPA_CSV.COUNT_NEW, "raw")
  const lightningSeries = keepaCsvSeries(keepa, KEEPA_CSV.LIGHTNING_DEAL, "price")
  const couponSeries = keepaCouponSeries(keepa)

  for (let index = 1; index < priceSeries.length; index += 1) {
    const previous = priceSeries[index - 1]
    const current = priceSeries[index]
    if (previous.value <= 0) continue
    const ratioPct = ((current.value - previous.value) / previous.value) * 100
    if (Math.abs(ratioPct) < 8) continue
    mergeTimelineEvent(events, current.date, {
      priceSignal: {
        dir: ratioPct < 0 ? "down" : "up",
        from: previous.value,
        to: current.value,
        ratioPct,
      },
      extraSignal: `Keepa 单日价格变动 ${formatSignedPercent(ratioPct)}`,
    })
  }

  for (let index = 1; index < bsrSeries.length; index += 1) {
    const previousPoint = bsrSeries[index - 1]
    const current = bsrSeries[index]
    const elapsedDays = (Date.parse(current.date) - Date.parse(previousPoint.date)) / DAY_MS
    if (elapsedDays > 3 || previousPoint.value <= 0 || previousPoint.value === current.value)
      continue
    const previous = previousPoint.value
    const improvement = (previous - current.value) / previous
    if (improvement > 0.4) {
      mergeTimelineEvent(events, current.date, {
        extraSignal: `BSR 3 日改善 ${(improvement * 100).toFixed(1)}%（#${previous.toLocaleString()}→#${current.value.toLocaleString()}）`,
      })
    } else if (improvement < -0.5) {
      mergeTimelineEvent(events, current.date, {
        extraSignal: `BSR 3 日恶化 ${(Math.abs(improvement) * 100).toFixed(1)}%（#${previous.toLocaleString()}→#${current.value.toLocaleString()}）`,
      })
    }
  }

  for (const point of couponSeries) {
    mergeTimelineEvent(events, point.date, { extraSignal: `出现 ${couponLabel(point.value)}` })
  }
  for (const point of lightningSeries) {
    mergeTimelineEvent(events, point.date, {
      extraSignal: `出现闪购价 $${point.value.toFixed(2)}`,
    })
  }
  for (const date of reviewSpikeDates(reviewSeries)) {
    const current = keepaValueAsOf(reviewSeries, date)
    const previous = keepaValueAsOf(reviewSeries, addDays(date, -7))
    if (current !== null && previous !== null) {
      mergeTimelineEvent(events, date, {
        extraSignal: `评论周增 ${Math.max(0, current - previous).toLocaleString()}，超过历史波动阈值`,
      })
    }
  }
  for (let index = 1; index < ratingSeries.length; index += 1) {
    const previous = ratingSeries[index - 1]
    const current = ratingSeries[index]
    const delta = (current.value - previous.value) / 10
    if (Math.abs(delta) < 0.2) continue
    mergeTimelineEvent(events, current.date, {
      extraSignal: `评分 ${delta > 0 ? "上升" : "下降"} ${Math.abs(delta).toFixed(1)}（${(
        previous.value / 10
      ).toFixed(1)}→${(current.value / 10).toFixed(1)}）`,
    })
  }

  const buyBoxHistory = keepaBuyBoxHistory(keepa)
  for (let index = 1; index < buyBoxHistory.length; index += 1) {
    const previous = buyBoxHistory[index - 1]
    const current = buyBoxHistory[index]
    if (previous.sellerId === current.sellerId) continue
    mergeTimelineEvent(events, current.date, {
      extraSignal: `Buy Box 换手 ${previous.sellerId}→${current.sellerId}`,
    })
  }
  for (let index = 1; index < offerSeries.length; index += 1) {
    const previous = offerSeries[index - 1]
    const current = offerSeries[index]
    if (previous.value === current.value) continue
    const delta = current.value - previous.value
    mergeTimelineEvent(events, current.date, {
      extraSignal: `Offer ${delta > 0 ? "+" : ""}${delta}（共 ${current.value}）`,
    })
  }

  return [...events.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-TIMELINE_ROW_LIMIT)
    .map(event => {
      const actions = buildSifActionsAroundDate(trend, dates, event.date, keywordTrendRows)
      if (!actions.length && event.extraSignals.some(signal => signal.startsWith("评论周增"))) {
        actions.push({
          type: "review",
          label: "同期无明确站内动作，疑似站外/催评，需人工复核",
        })
      }
      return {
        date: event.date,
        priceSignal: event.priceSignal,
        extraSignals: event.extraSignals,
        actions,
        bsrEffect: keepaBsrEffect(bsrSeries, event.date),
      }
    })
}

function mergeTimelineEvent(
  events: Map<string, TimelineEvent>,
  date: string,
  input: { priceSignal?: JsonRecord; extraSignal?: string }
): void {
  const event = events.get(date) ?? { date, priceSignal: null, extraSignals: [] }
  if (input.priceSignal) event.priceSignal = input.priceSignal
  if (input.extraSignal && !event.extraSignals.includes(input.extraSignal)) {
    event.extraSignals.push(input.extraSignal)
  }
  events.set(date, event)
}

function buildSifActionsAroundDate(
  trend: JsonRecord,
  dates: string[],
  eventDate: string,
  keywordTrendRows: JsonRecord[]
): JsonRecord[] {
  if (!dates.length) return []
  const fromDate = addDays(eventDate, -ATTRIBUTION_WINDOW_DAYS)
  const toDate = addDays(eventDate, ATTRIBUTION_WINDOW_DAYS)
  const from = sifIndexOnOrAfter(dates, fromDate)
  const to = sifIndexAfter(dates, toDate)
  const actions: JsonRecord[] = []
  const campaignsAdded = sumRange(trend.campaign, from, to)
  const adGroupsAdded = sumRange(trend.ad, from, to)
  if (hasValueInRange(trend.title, from, to)) {
    actions.push({ type: "listing", label: "修改标题（SIF ±3 天）" })
  }
  if (hasValueInRange(trend.img, from, to)) {
    actions.push({ type: "listing", label: "修改主图（SIF ±3 天）" })
  }
  if (campaignsAdded > 0) {
    actions.push({ type: "ad", label: `新增 ${campaignsAdded} 个广告活动` })
  }
  if (adGroupsAdded > 0) {
    actions.push({ type: "ad", label: `新增 ${adGroupsAdded} 个广告组` })
  }
  const coupon = lastValueInRange(trend.couponInfo, from, to)
  if (coupon !== null && coupon !== 0) {
    actions.push({ type: "promo", label: `上 ${couponLabel(coupon)}` })
  }
  if (hasValueInRange(trend.ldPrice, from, to)) {
    actions.push({ type: "promo", label: "上闪购" })
  }
  const previousPrice = lastPositiveValueInRange(trend.buyboxPrice, 0, from)
  const currentPrice = lastPositiveValueInRange(trend.buyboxPrice, from, to)
  if (previousPrice !== null && currentPrice !== null && previousPrice !== currentPrice) {
    actions.push({
      type: "price",
      label: `SIF ${currentPrice < previousPrice ? "降价" : "涨价"} ${formatSignedPercent(
        ((currentPrice - previousPrice) / previousPrice) * 100
      )}`,
    })
  }

  const previousAdScore = lastValueInRange(trend.adScore, 0, from)
  const currentAdScore = lastValueInRange(trend.adScore, from, to)
  const previousNaturalScore = lastValueInRange(trend.nfScore, 0, from)
  const currentNaturalScore = lastValueInRange(trend.nfScore, from, to)
  if (
    previousAdScore !== null &&
    currentAdScore !== null &&
    currentAdScore > previousAdScore &&
    (previousNaturalScore === null ||
      currentNaturalScore === null ||
      currentNaturalScore <= previousNaturalScore)
  ) {
    actions.push({ type: "ad", label: "广告得分上升，流量更偏广告驱动" })
  } else if (
    previousAdScore !== null &&
    currentAdScore !== null &&
    currentAdScore < previousAdScore
  ) {
    actions.push({ type: "ad", label: "广告得分下降，疑似减投/停投" })
  }
  if (
    previousNaturalScore !== null &&
    currentNaturalScore !== null &&
    currentNaturalScore > previousNaturalScore
  ) {
    actions.push({ type: "listing", label: "自然流量得分上升，SEO/自然位见效" })
  }
  actions.push(...keywordActionsAroundDate(keywordTrendRows, fromDate, toDate))
  return deduplicateActions(actions)
}

function keywordActionsAroundDate(
  keywordRows: JsonRecord[],
  fromDate: string,
  toDate: string
): JsonRecord[] {
  const actions: JsonRecord[] = []
  for (const row of keywordRows) {
    const keyword = stringValue(row.keyword)
    if (!keyword) continue
    const naturalImproved = rankingImprovedInWindow(row.naturalPositionSeq, fromDate, toDate)
    const adImproved = rankingImprovedInWindow(row.spPositionSeq, fromDate, toDate)
    if (naturalImproved) {
      actions.push({ type: "listing", label: `自然词「${keyword}」排名提升` })
    }
    if (adImproved) {
      actions.push({ type: "ad", label: `广告词「${keyword}」排名提升` })
    }
    if (actions.length >= 2) break
  }
  return actions
}

function rankingImprovedInWindow(value: unknown, fromDate: string, toDate: string): boolean {
  const points = arrayRecords(value)
    .map(point => ({
      date: stringValue(point.date),
      rank: nullableNumber(
        point.allPageRank ??
          point.currentPageNfRank ??
          point.currentPagSpfRank ??
          point.currentPageRank
      ),
    }))
    .filter(
      (point): point is { date: string; rank: number } => Boolean(point.date) && point.rank !== null
    )
    .sort((left, right) => left.date.localeCompare(right.date))
  const before = points.filter(point => point.date < fromDate).at(-1)
  const during = points.filter(point => point.date >= fromDate && point.date <= toDate).at(-1)
  return Boolean(before && during && during.rank < before.rank)
}

function keepaBsrEffect(bsrSeries: KeepaSeriesPoint[], eventDate: string): JsonRecord | null {
  const previous = bsrSeries.filter(point => point.date < eventDate).at(-1)?.value ?? null
  const current = keepaValueAsOf(bsrSeries, addDays(eventDate, ATTRIBUTION_WINDOW_DAYS))
  return previous !== null && current !== null
    ? { from: previous, to: current, delta: previous - current }
    : null
}

function reviewSpikeDates(reviewSeries: KeepaSeriesPoint[]): string[] {
  if (reviewSeries.length < 4) return []
  const weeklyDeltas = reviewSeries
    .map(point => {
      const previous = keepaValueAsOf(reviewSeries, addDays(point.date, -7))
      return previous === null
        ? null
        : { date: point.date, delta: Math.max(0, point.value - previous) }
    })
    .filter((item): item is { date: string; delta: number } => Boolean(item))
  return weeklyDeltas.flatMap((item, index) => {
    const history = weeklyDeltas.slice(Math.max(0, index - 12), index).map(row => row.delta)
    if (history.length < 3) return []
    const mean = history.reduce((sum, value) => sum + value, 0) / history.length
    const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / history.length
    return item.delta > mean + 3 * Math.sqrt(variance) ? [item.date] : []
  })
}

function buildSifTimeline(trend: JsonRecord, dates: string[]): JsonRecord[] {
  if (!dates.length) return []
  const start = Math.max(0, dates.length - TIMELINE_ROW_LIMIT * 7)
  const result: JsonRecord[] = []
  for (let from = start; from < dates.length; from += 7) {
    const to = Math.min(dates.length, from + 7)
    const previousPrice = lastPositiveValueInRange(trend.buyboxPrice, Math.max(0, from - 7), from)
    const currentPrice = lastPositiveValueInRange(trend.buyboxPrice, from, to)
    const previousBsr = lastValueInRange(trend.bsr, Math.max(0, from - 7), from)
    const currentBsr = lastValueInRange(trend.bsr, from, to)
    const extraSignals: string[] = []
    const coupon = lastValueInRange(trend.couponInfo, from, to)
    if (coupon !== null && coupon !== 0) extraSignals.push(couponLabel(coupon))
    if (hasValueInRange(trend.ldPrice, from, to)) extraSignals.push("闪购期")
    if (hasValueInRange(trend.dealPrice, from, to)) extraSignals.push("Deal")
    const actions: JsonRecord[] = []
    if (hasValueInRange(trend.title, from, to)) actions.push({ type: "listing", label: "修改标题" })
    if (hasValueInRange(trend.img, from, to)) actions.push({ type: "listing", label: "修改主图" })
    if (sumRange(trend.campaign, from, to) > 0) actions.push({ type: "ad", label: "新增广告活动" })
    if (sumRange(trend.ad, from, to) > 0) actions.push({ type: "ad", label: "扩展广告组" })
    if (coupon !== null && coupon !== 0) actions.push({ type: "promo", label: couponLabel(coupon) })
    if (currentPrice !== null && previousPrice !== null && currentPrice !== previousPrice) {
      actions.push({ type: "price", label: currentPrice < previousPrice ? "降价" : "涨价" })
    }
    result.push({
      date: dates[from],
      priceSignal:
        currentPrice !== null && previousPrice !== null
          ? {
              dir:
                currentPrice < previousPrice
                  ? "down"
                  : currentPrice > previousPrice
                    ? "up"
                    : "flat",
              from: previousPrice,
              to: currentPrice,
              ratioPct:
                previousPrice === 0 ? 0 : ((currentPrice - previousPrice) / previousPrice) * 100,
            }
          : null,
      extraSignals,
      actions,
      bsrEffect:
        currentBsr !== null && previousBsr !== null
          ? { from: previousBsr, to: currentBsr, delta: previousBsr - currentBsr }
          : null,
    })
  }
  return result.slice(-TIMELINE_ROW_LIMIT)
}

function buildAdGroups(keywords: JsonRecord[]): JsonRecord[] {
  const grouped = new Map<string, JsonRecord[]>()
  for (const keyword of keywords.filter(row => numberValue(row.adScoreRatio) > 0 || row.spRank)) {
    const words = keywordTokens(stringValue(keyword.keyword))
    const root = words[0] ?? "其他"
    grouped.set(root, [...(grouped.get(root) ?? []), keyword])
  }
  return [...grouped.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .map(([root, rows]) => {
      const match = inferKeywordMatch(rows.map(row => stringValue(row.keyword)))
      return {
        root,
        keywordCount: rows.length,
        structure: match.structure,
        targeting: "手动广告为主",
        matchMode: match.mode,
        confidence: rows.length >= 3 ? "medium" : "low",
        reason: `${rows.length} 个词归入「${root}」，${match.structure}。`,
        keywords: rows.map(row => stringValue(row.keyword)),
      }
    })
}

function buildAdCampaigns(adRows: JsonRecord[]): JsonRecord[] {
  const campaigns = new Map<string, Map<string, AdCampaignCell>>()
  for (const keywordRow of adRows) {
    for (const variant of arrayRecords(keywordRow.variants)) {
      const campaignIds = stringArray(variant.campaignIds)
      const adIds = stringArray(variant.adIds)
      campaignIds.forEach((campaignId, index) => {
        const adId = adIds[index] ?? adIds[0] ?? "未识别广告组"
        const groups = campaigns.get(campaignId) ?? new Map<string, AdCampaignCell>()
        const cell: AdCampaignCell = groups.get(adId) ?? {
          keywords: new Set<string>(),
          score: 0,
          histories: [],
        }
        cell.keywords.add(stringValue(keywordRow.keyword))
        cell.score += numberValue(variant.adScore)
        cell.histories.push(...arrayRecords(variant.spHistory))
        groups.set(adId, cell)
        campaigns.set(campaignId, groups)
      })
    }
  }
  return [...campaigns.entries()]
    .map(([campaignId, groups]) => {
      const totalScore = [...groups.values()].reduce((sum, group) => sum + group.score, 0)
      const allHistories = [...groups.values()].flatMap(group => group.histories)
      const groupRows = [...groups.entries()]
        .map(([adGroupId, group]) => {
          const keywords = [...group.keywords]
          const match = inferKeywordMatch(keywords)
          return {
            adGroupId,
            matchMode: match.mode.replace("匹配", ""),
            structure: `手动 · ${match.structure}`,
            keywordCount: keywords.length,
            keywordTrend: buildKeywordTrend(group.histories),
            adScore: group.score,
            sharePct: totalScore > 0 ? Math.round((group.score / totalScore) * 100) : 0,
          }
        })
        .sort((left, right) => right.adScore - left.adScore)
      const firstDate = allHistories
        .map(item => stringValue(item.date))
        .filter(Boolean)
        .sort()[0]
      return {
        type: campaignType(campaignId),
        campaignId,
        adGroupCount: groupRows.length,
        asinCount: 1,
        createdAt: firstDate ?? "—",
        score: totalScore,
        scoreChange: 0,
        groups: groupRows,
      }
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
}

function buildKeywordCards(adRows: JsonRecord[], asin: string, totalScore: number): JsonRecord[] {
  return adRows.slice(0, KEYWORD_TABLE_SIZE).map(row => ({
    keyword: stringValue(row.keyword),
    searchVolume: numberValue(row.searchVolume),
    adScoreRatio: percentageValue(row.spScoreRatio),
    listingAdScoreRatio:
      totalScore > 0 ? numberValue(row.kwSpScoreRatio ?? row.spScoreRatio) / totalScore : 0,
    campaignCountEstimate: maxNumber(arrayRecords(row.variants).map(item => item.campaignIdNum)),
    adGroupCountEstimate: maxNumber(arrayRecords(row.variants).map(item => item.adIdNum)),
    variants: arrayRecords(row.variants).map(variant => ({
      asin: upperString(variant.asin) || asin,
      adScore: numberValue(variant.adScore),
      exposureDays: numberValue(variant.days),
      spHistory: arrayRecords(variant.spHistory).map(point => ({
        date: stringValue(point.date),
        rank: spRankFromHistory([point]),
      })),
    })),
  }))
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : []
}

function rowsOf(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return arrayRecords(value)
  return arrayRecords(asRecord(value).list)
}

function mapRecords(
  rows: JsonRecord[],
  keyOf: (row: JsonRecord) => string
): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>()
  for (const row of rows) {
    const key = keyOf(row)
    if (key) result.set(key, row)
  }
  return result
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => stringValue(item)).filter(Boolean) : []
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function upperString(value: unknown): string {
  return stringValue(value).toUpperCase()
}

function normalizedKeyword(value: unknown): string {
  return stringValue(value).toLowerCase().replace(/\s+/g, " ")
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = numberValue(value, NaN)
  return Number.isFinite(parsed) ? parsed : null
}

function percentageValue(value: unknown): number {
  const parsed = numberValue(value)
  return parsed > 1 ? parsed / 100 : parsed
}

function numericSeries(value: unknown): Array<number | null> {
  return Array.isArray(value) ? value.map(item => nullableNumber(item)) : []
}

function lastNumber(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) return values[index]
  }
  return null
}

function lastPositiveNumber(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null && numberValue(values[index]) > 0) return values[index]
  }
  return null
}

function maxNumber(values: unknown[]): number {
  return values.length ? Math.max(0, ...values.map(value => numberValue(value))) : 0
}

function daysSince(date: string): number | null {
  const timestamp = Date.parse(date)
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS))
    : null
}

function ratioChange(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null
}

function rankFromSequence(value: unknown, isSponsored: boolean): string | null {
  const rows = arrayRecords(value)
  const latest = rows.at(-1)
  if (!latest) return null
  const page = nullableNumber(latest.page)
  const rank = nullableNumber(
    isSponsored
      ? (latest.currentPagSpfRank ?? latest.currentPageRank ?? latest.allPageRank)
      : (latest.currentPageNfRank ?? latest.allPageRank)
  )
  return rank === null ? null : `p${page ?? "?"},${rank}`
}

function spRankFromHistory(history: JsonRecord[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const position = asRecord(history[index].position)
    const rank = nullableNumber(position.currentPageRank)
    if (rank !== null) {
      return `p${nullableNumber(position.page) ?? "?"},${rank}/${nullableNumber(position.currentPageTotalAsinCount) ?? "?"}`
    }
  }
  return null
}

function keywordTokens(keyword: string): string[] {
  const stopWords = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"])
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(word => word && !stopWords.has(word))
}

function inferKeywordMatch(keywords: string[]): { mode: string; structure: string } {
  const unique = [...new Set(keywords.map(normalizedKeyword))].filter(Boolean)
  if (unique.length <= 1) return { mode: "精准匹配", structure: "无延展" }
  const tokenLists = unique.map(keywordTokens)
  const common = tokenLists[0].filter(token => tokenLists.every(tokens => tokens.includes(token)))
  if (!common.length) return { mode: "广泛匹配", structure: "词序打乱 / 无公共词根" }
  const root = common.join(" ")
  const contiguous = tokenLists.every(tokens => tokens.join(" ").includes(root))
  if (!contiguous) return { mode: "广泛匹配", structure: "词序打乱" }
  return { mode: "词组匹配", structure: "首尾插词" }
}

function buildKeywordTrend(histories: JsonRecord[]): number[] {
  const byDate = new Map<string, number[]>()
  for (const history of histories) {
    const date = stringValue(history.date)
    const rank = nullableNumber(history.rank)
    if (date && rank !== null) byDate.set(date, [...(byDate.get(date) ?? []), rank])
  }
  const averages = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-8)
    .map(([, ranks]) => ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length)
  if (averages.length < 2) return []
  const maximum = Math.max(...averages)
  return averages.map(value => maximum - value)
}

function campaignType(campaignId: string): string {
  const lower = campaignId.toLowerCase()
  return lower.includes("sbv") ? "SBV" : lower.includes("sb") ? "SB" : "SP"
}

const KEEPA_PRICE_CHANNELS = [
  { key: "buyBox", label: "Buy Box", csvIndex: KEEPA_CSV.BUY_BOX_SHIPPING },
  { key: "amazon", label: "Amazon 直营", csvIndex: KEEPA_CSV.AMAZON },
  { key: "new", label: "New 最低", csvIndex: KEEPA_CSV.NEW },
  { key: "fba", label: "New·第三方 FBA", csvIndex: KEEPA_CSV.NEW_FBA },
  { key: "fbm", label: "New·第三方 FBM", csvIndex: KEEPA_CSV.NEW_FBM_SHIPPING },
  { key: "used", label: "Used 二手", csvIndex: KEEPA_CSV.USED },
  { key: "list", label: "List Price 官方价", csvIndex: KEEPA_CSV.LISTPRICE },
  { key: "deal", label: "Lightning Deal", csvIndex: KEEPA_CSV.LIGHTNING_DEAL },
] as const

function buildPricePromoSeries(
  keepa: JsonRecord | null,
  trend: JsonRecord,
  dates: string[],
  keepaState: string
): JsonRecord {
  const keepaDates = KEEPA_PRICE_CHANNELS.flatMap(channel =>
    keepaCsvSeries(keepa, channel.csvIndex, "price").map(point => point.date)
  )
  if (keepaDates.length) {
    const endDate = keepaDates.sort().at(-1) ?? ""
    const startDate = addDays(endDate, -(SERIES_DAY_LIMIT - 1))
    const channels = KEEPA_PRICE_CHANNELS.flatMap(channel => {
      const points = clipKeepaSeries(
        keepaCsvSeries(keepa, channel.csvIndex, "price"),
        startDate,
        endDate
      )
      return points.length
        ? [{ key: channel.key, label: channel.label, points, latest: points.at(-1)?.value ?? null }]
        : []
    })
    return {
      channels,
      salesRank: clipKeepaSeries(keepaCsvSeries(keepa, KEEPA_CSV.SALES, "raw"), startDate, endDate),
      startDate,
      endDate,
      source: "keepa",
      sourceState: "keepa",
    }
  }

  const channels = [
    buildPriceChannel("buyBox", "Buy Box", trend.buyboxPrice, dates),
    buildPriceChannel("prime", "Prime", trend.primePrice, dates),
    buildPriceChannel("deal", "Deal", trend.dealPrice ?? trend.ldPrice, dates),
  ].filter((channel): channel is JsonRecord => Boolean(channel))
  const keepaSalesRank = keepaCsvSeries(keepa, KEEPA_CSV.SALES, "raw")
  const salesRank = keepaSalesRank.length
    ? keepaSalesRank.slice(-SERIES_DAY_LIMIT).map(point => ({ ...point }))
    : buildSeriesPoints(dates, trend.bsr, SERIES_DAY_LIMIT)
  const allDates = [
    ...channels.flatMap(channel =>
      arrayRecords(channel.points).map(point => stringValue(point.date))
    ),
    ...salesRank.map(point => stringValue(point.date)),
  ].filter(Boolean)
  return {
    channels,
    salesRank,
    startDate: allDates.sort()[0] ?? "",
    endDate: allDates.sort().at(-1) ?? "",
    source: "sif",
    sourceState: keepaState === "keepa" ? "unavailable" : keepaState,
  }
}

function clipKeepaSeries(
  points: KeepaSeriesPoint[],
  startDate: string,
  endDate: string
): JsonRecord[] {
  const inWindow = points.filter(point => point.date >= startDate && point.date <= endDate)
  const carryIn = points.filter(point => point.date < startDate).at(-1)
  const normalized = inWindow.map(point => ({ date: point.date, value: point.value }))
  return carryIn && (!inWindow.length || inWindow[0].date > startDate)
    ? [{ date: startDate, value: carryIn.value }, ...normalized]
    : normalized
}

function preferredKeepaPriceSeries(keepa: JsonRecord | null): KeepaSeriesPoint[] {
  return (
    [
      KEEPA_CSV.BUY_BOX_SHIPPING,
      KEEPA_CSV.AMAZON,
      KEEPA_CSV.NEW,
      KEEPA_CSV.NEW_FBA,
      KEEPA_CSV.NEW_FBM_SHIPPING,
    ]
      .map(csvIndex => keepaCsvSeries(keepa, csvIndex, "price"))
      .find(points => points.length) ?? []
  )
}

function hasKeepaSignalHistory(keepa: JsonRecord | null): boolean {
  return Boolean(
    preferredKeepaPriceSeries(keepa).length ||
    keepaCsvSeries(keepa, KEEPA_CSV.SALES, "raw").length ||
    keepaCsvSeries(keepa, KEEPA_CSV.COUNT_REVIEWS, "raw").length ||
    keepaCsvSeries(keepa, KEEPA_CSV.RATING, "raw").length ||
    keepaCsvSeries(keepa, KEEPA_CSV.COUNT_NEW, "raw").length ||
    keepaCouponSeries(keepa).length ||
    keepaBuyBoxHistory(keepa).length
  )
}

function hasKeepaPromotionHistory(keepa: JsonRecord | null): boolean {
  return Boolean(
    keepaCouponSeries(keepa).length ||
    keepaCsvSeries(keepa, KEEPA_CSV.LIGHTNING_DEAL, "price").length
  )
}

function keepaCurrentPrice(keepa: JsonRecord | null): number | null {
  return preferredKeepaPriceSeries(keepa).at(-1)?.value ?? null
}

function currentBoardPrice(
  keepa: JsonRecord | null,
  trend: JsonRecord,
  priceRow: JsonRecord | undefined,
  profile: JsonRecord | undefined
): number {
  return (
    keepaCurrentPrice(keepa) ??
    lastPositiveNumber(numericSeries(trend.buyboxPrice)) ??
    numberValue(priceRow?.currentPrice ?? profile?.price)
  )
}

function buildPriceChannel(
  key: string,
  label: string,
  values: unknown,
  dates: string[]
): JsonRecord | null {
  const points = buildSeriesPoints(dates, values, SERIES_DAY_LIMIT)
  return points.length ? { key, label, points, latest: numberValue(points.at(-1)?.value) } : null
}

function buildSeriesPoints(dates: string[], values: unknown, limit: number): JsonRecord[] {
  const series = numericSeries(values)
  const start = Math.max(0, dates.length - limit)
  return dates
    .slice(start)
    .map((date, offset) => ({ date, value: nullableNumber(series[start + offset]) }))
    .filter(
      (point): point is { date: string; value: number } => point.value !== null && point.value > 0
    )
}

function lastValueInRange(value: unknown, from: number, to: number): number | null {
  const series = numericSeries(value)
  for (let index = Math.min(to, series.length) - 1; index >= Math.max(0, from); index -= 1) {
    if (series[index] !== null) return series[index]
  }
  return null
}

function lastPositiveValueInRange(value: unknown, from: number, to: number): number | null {
  const series = numericSeries(value)
  for (let index = Math.min(to, series.length) - 1; index >= Math.max(0, from); index -= 1) {
    if (series[index] !== null && numberValue(series[index]) > 0) return series[index]
  }
  return null
}

function hasValueInRange(value: unknown, from: number, to: number): boolean {
  const series = numericSeries(value)
  return series.slice(Math.max(0, from), Math.max(0, to)).some(item => item !== null && item !== 0)
}

function sumRange(value: unknown, from: number, to: number): number {
  return numericSeries(value)
    .slice(Math.max(0, from), Math.max(0, to))
    .reduce<number>((sum, item) => sum + (item ?? 0), 0)
}

function countPromotions(trend: JsonRecord, dates: string[]): number {
  const start = Math.max(0, dates.length - 30)
  let count = 0
  for (let index = start; index < dates.length; index += 1) {
    if (
      (numericSeries(trend.couponInfo)[index] ?? 0) !== 0 ||
      (numericSeries(trend.ldPrice)[index] ?? 0) > 0 ||
      (numericSeries(trend.dealPrice)[index] ?? 0) > 0
    )
      count += 1
  }
  return count
}

function countKeepaPromotions(keepa: JsonRecord | null, endDateValue: unknown): number {
  const endDate = stringValue(endDateValue) || keepaLatestDate(keepa)
  if (!endDate) return 0
  const startDate = addDays(endDate, -29)
  const dates = new Set([
    ...keepaCouponSeries(keepa)
      .filter(point => point.date >= startDate && point.date <= endDate)
      .map(point => point.date),
    ...keepaCsvSeries(keepa, KEEPA_CSV.LIGHTNING_DEAL, "price")
      .filter(point => point.date >= startDate && point.date <= endDate)
      .map(point => point.date),
  ])
  return dates.size
}

function priceVolatility(channels: JsonRecord[]): "high" | "low" | null {
  const values = channels.flatMap(channel =>
    arrayRecords(channel.points)
      .map(point => numberValue(point.value))
      .filter(value => value > 0)
  )
  if (values.length < 2) return null
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return average > 0 && (Math.max(...values) - Math.min(...values)) / average > 0.05
    ? "high"
    : "low"
}

function couponLabel(coupon: number): string {
  return coupon < 0 ? `${Math.abs(coupon)}%券` : coupon > 0 ? `$${coupon}券` : "促销"
}

function buildVerdict(metrics: JsonRecord, timeline: JsonRecord[], signalSource: string): string {
  const parts = [
    metrics.priceVolatility === "high"
      ? "价格波动较大"
      : metrics.priceVolatility === "low"
        ? "价格整体稳定"
        : "价格序列不足",
    numberValue(metrics.promoCount30d) > 0
      ? `近 30 天观测到 ${numberValue(metrics.promoCount30d)} 天促销信号`
      : "近 30 天未观测到促销信号",
    nullableNumber(metrics.bsrDelta) === null
      ? "BSR 效果数据不足"
      : numberValue(metrics.bsrDelta) > 0
        ? "BSR 整体改善"
        : "BSR 整体承压",
    timeline.some(row => arrayRecords(row.actions).some(action => action.type === "ad"))
      ? "同期存在广告扩量动作"
      : "未观测到明确广告扩量动作",
  ]
  const sourceLabel = signalSource === "keepa" ? "Keepa" : "SIF 兜底"
  return `${sourceLabel} 侧观测到${parts.join("；")}；SIF 侧动作仅表示 ±3 天同期共变，不代表因果。`
}

function keepaSourceState(evidence: CompetitorEvidenceBundle): string {
  const source = evidence.sources.find(item => item.provider === "keepa")
  if (!source) return "not_configured"
  return source.status === "used" ? "keepa" : source.status
}

function sourcedValue(
  keepaValue: number | null,
  sifValue: number | null
): { value: number | null; source?: "keepa" | "sif" } {
  if (keepaValue !== null) return { value: keepaValue, source: "keepa" }
  if (sifValue !== null) return { value: sifValue, source: "sif" }
  return { value: null }
}

function sourceOfWeek(week: JsonRecord | undefined, field: string): string | undefined {
  return week ? stringValue(asRecord(week.sources)[field]) || undefined : undefined
}

function inventoryLabel(week: JsonRecord | undefined): string | null {
  const stock = nullableNumber(week?.stock)
  if (stock !== null) return `库存 ${stock}`
  const offerCount = nullableNumber(week?.offerCount)
  return offerCount === null ? null : `Offer ${offerCount}`
}

function addDays(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(timestamp)
    ? new Date(timestamp + days * DAY_MS).toISOString().slice(0, 10)
    : date
}

function sifIndexOnOrAfter(dates: string[], date: string): number {
  const index = dates.findIndex(item => item >= date)
  return index < 0 ? dates.length : index
}

function sifIndexAfter(dates: string[], date: string): number {
  const index = dates.findIndex(item => item > date)
  return index < 0 ? dates.length : index
}

function lastValueOnOrBefore(
  values: unknown,
  dates: string[],
  dateIndex: Map<string, number>,
  toDate: string
): number | null {
  let result: number | null = null
  const series = numericSeries(values)
  for (const date of dates) {
    if (date > toDate) break
    const index = dateIndex.get(date)
    if (index !== undefined && series[index] !== null) result = series[index]
  }
  return result
}

function lastPositiveValueOnOrBefore(
  values: unknown,
  dates: string[],
  dateIndex: Map<string, number>,
  toDate: string
): number | null {
  const series = numericSeries(values)
  let result: number | null = null
  for (const date of dates) {
    if (date > toDate) break
    const index = dateIndex.get(date)
    const value = index === undefined ? null : series[index]
    if (value !== null && value > 0) result = value
  }
  return result
}

function firstValueInDateRange(
  values: unknown,
  dates: string[],
  fromDate: string,
  toDate: string
): number | null {
  const series = numericSeries(values)
  for (let index = 0; index < dates.length; index += 1) {
    if (dates[index] < fromDate || dates[index] > toDate) continue
    if (series[index] !== null && series[index] !== 0) return series[index]
  }
  return null
}

function firstPositiveValueInDateRange(
  values: unknown,
  dates: string[],
  fromDate: string,
  toDate: string
): number | null {
  const value = firstValueInDateRange(values, dates, fromDate, toDate)
  return value !== null && value > 0 ? value : null
}

function deduplicateActions(actions: JsonRecord[]): JsonRecord[] {
  return actions.filter(
    (action, index) =>
      actions.findIndex(candidate => stringValue(candidate.label) === stringValue(action.label)) ===
      index
  )
}

function formatSignedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`
}

function periodTrend(values: Array<number | null>, windowSize: number): number | null {
  if (values.length < windowSize * 2) return null
  const average = (items: Array<number | null>): number | null => {
    const present = items.filter(
      (value): value is number => value !== null && Number.isFinite(value)
    )
    return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null
  }
  const first = average(values.slice(-windowSize * 2, -windowSize))
  const last = average(values.slice(-windowSize))
  return first !== null && last !== null && first !== 0 ? (last - first) / first : null
}

function inferStage(
  listedDays: number | null,
  salesTrend: number | null,
  bsrTrend: number | null
): string {
  if (listedDays !== null && listedDays < 120) return "新品期"
  if (salesTrend === null || bsrTrend === null) return "数据不足"
  if (Math.abs(salesTrend) < 0.05 || Math.abs(bsrTrend) < 0.05) return "稳定期"
  if (salesTrend > 0 && bsrTrend < 0) return "增长期"
  if (salesTrend > 0) return "增长承压"
  if (bsrTrend < 0) return "效率调整期"
  return "成熟承压 / 早期衰退"
}

function formatPercent(value: number | null): string {
  return value === null ? "数据不足" : `${(value * 100).toFixed(1)}%`
}
