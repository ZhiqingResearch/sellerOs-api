import { precheckBrandInTitle } from "../rules/title-precheck"
import type { AuditEvidence, ReviewPainPoint } from "../types/audit.types"

/** 六卡证据 → prompt 片段的共享格式化工具。
 *  打分端（asin-audit-score.ts）与优化端（asin-audit-optimize.ts）共用，避免重复。 */

export function cardSection(title: string, body: string): string {
  return `## ${title}\n${body}\n`
}

export function formatListingA(A: AuditEvidence["A"]): string {
  if (!A.filled) {
    return "【未取证】用户未粘贴 Listing 全文，相关维度请保守评分。\n"
  }
  const bullets = A.bullets?.map((b, i) => `${i + 1}. ${b}`).join("\n") ?? "(未提供)"
  const terms = Array.isArray(A.searchTerms) ? A.searchTerms.join(" ") : "(未提供)"
  const stBytes = Buffer.byteLength(terms === "(未提供)" ? "" : terms, "utf8")
  const lines = [
    `标题：${A.title ?? "(未提供)"}（${A.title?.length ?? 0} 字符）`,
    // 爬虫的 title 常是截断短标题，主要卖点在 second_title 里——必须一并给模型，否则只能凭空编
    ...(A.secondTitle
      ? [`副标题（second_title，${A.secondTitle.length} 字符）：${A.secondTitle}`]
      : []),
    `Bullet Points（${A.bullets?.length ?? 0} 条）：\n${bullets}`,
    `产品描述：${A.description ?? "(未提供)"}`,
    `后台搜索词（${stBytes} 字节 / 250 上限）：${terms}`,
    `图片数：${A.imageCount ?? "未知"}`,
    `产品视频：${A.hasVideo == null ? "未知" : A.hasVideo ? "有" : "无"}`,
  ]

  const qaList = A.qa ?? []
  lines.push(`Q&A 条数：${qaList.length || A.qaCount || 0}`)
  if (qaList.length > 0) {
    const qaText = qaList
      .slice(0, 10)
      .map((item, i) => `  Q${i + 1}: ${item.q}\n  A: ${item.a}`)
      .join("\n")
    lines.push(`Q&A 内容（前 ${Math.min(qaList.length, 10)} 条）：\n${qaText}`)
  }

  const aplusImages = A.aplusImages ?? []
  const aplusModules = A.aplusModules ?? []
  if (aplusImages.length > 0) {
    lines.push(`A+：有（${aplusImages.length} 张图片）`)
  } else if (aplusModules.length > 0) {
    const modText = aplusModules.map((m, i) => `  ${i + 1}. ${m.type}: ${m.desc}`).join("\n")
    lines.push(`A+：有（${aplusModules.length} 个模块）\n${modText}`)
  } else {
    lines.push(`A+：${A.hasAplus == null ? "未知" : A.hasAplus ? "有" : "无"}`)
  }

  return lines.join("\n")
}

export function formatParamsP(P: AuditEvidence["P"]): string {
  if (!P.filled) return `【未取证】${P.missingReason ?? ""}`

  if (P.groups?.length) {
    return P.groups
      .map(g => {
        const fields = g.fields
          .filter(f => f.k && f.v)
          .map(f => `  - ${f.k}: ${f.v}`)
          .join("\n")
        return `### ${g.name}\n${fields}`
      })
      .join("\n")
  }

  if (P.attributes?.length) {
    return P.attributes.map(a => `- ${a.name}: ${a.value}`).join("\n")
  }

  return "(无参数数据)"
}

export function formatReviewB(B: AuditEvidence["B"]): string {
  if (!B.filled) return `【未取证】${B.missingReason ?? ""}`

  const lines = [`评分：${B.rating ?? "—"} ★`, `评论数：${B.reviewCount ?? "—"}`]

  if (B.dist?.length) {
    const distText = B.dist.map(d => `  ${d.label}: ${d.pct}${d.bad ? " ⚠️" : ""}`).join("\n")
    lines.push(`评分分布：\n${distText}`)
  }

  const painPoints = B.richPainPoints ?? B.painPoints?.map(t => ({ text: t }))
  if (painPoints?.length) {
    const ppText = painPoints
      .slice(0, 10)
      .map((p: ReviewPainPoint) => {
        const freq = p.freq ? `（出现 ${p.freq} 次）` : ""
        return `  - ${p.text}${freq}`
      })
      .join("\n")
    lines.push(`差评痛点（前 ${Math.min(painPoints.length, 10)} 条）：\n${ppText}`)
  } else {
    lines.push(`差评痛点：—`)
  }

  return lines.join("\n")
}

export function formatTrafficPrecompute(D: AuditEvidence["D"]): string {
  const pc = D.trafficPrecompute
  if (!pc) return "（预计算块不可用，请仅根据 kwTop 保守估计第⑧维）\n"
  const lines = [
    ...pc.summaryLines.map(l => `- ${l}`),
    `- Top10 首页命中数：${pc.top10Page1Hits}`,
    `- 加权自然流量占比：${pc.weightedNaturalPct != null ? `${pc.weightedNaturalPct.toFixed(1)}%` : "N/A"}`,
    `- 机会词约：${pc.opportunityCount} 个`,
    `- Top1 流量集中度：${pc.top1ConcentrationPct.toFixed(1)}%`,
  ]
  if (pc.structure) {
    const s = pc.structure
    lines.push(
      `- 流量结构：自然占比 ${s.naturalPct ?? "N/A"}% / 广告依赖度 ${s.adDependencyPct ?? "N/A"}% / Top5 集中度 ${s.top5ConcentrationPct}% / 首页命中率 ${s.homepageHitRate}%（${s.homepageHits}/${s.totalKw} 词）`
    )
  }
  if (pc.tierBuckets) {
    const t = pc.tierBuckets
    lines.push(
      `- 流量层级打标：核心 ${t.core} / 腰部 ${t.waist} / 长尾 ${t.longtail} / 机会 ${t.opportunity}`
    )
  }
  if (pc.positionAllocation?.length) {
    lines.push(
      `- 位置分配原料(positionAllocation，子维度1)：${JSON.stringify(pc.positionAllocation)}`
    )
  }
  if (pc.opportunityList?.length) {
    lines.push(`- 机会词清单(opportunityList，子维度3)：${JSON.stringify(pc.opportunityList)}`)
  }
  if (pc.concentration) {
    lines.push(`- 集中度原料(concentration，子维度4)：${JSON.stringify(pc.concentration)}`)
  }
  if (pc.bsrTrend) {
    const bt = pc.bsrTrend
    if (!bt.available) {
      lines.push(
        `- I3 排名趋势（BSR 口径）：⏸ ${bt.reason ?? "日级序列不足"} → I3 判待核（score=null）`
      )
    } else {
      lines.push(
        `- I3 排名趋势（BSR 口径，前 7 天 vs 后 7 天）：${bt.tier.label} → 建议得分 ${bt.tier.score}/${bt.tier.max}`,
        `- 尾部连续劣于前 7 天基线 ${bt.declinedDays} 天（下滑持续天数，止跌路径回指 H2b）`,
        `- 近 ${bt.windowDays} 天 BSR 日级序列：${(bt.series ?? [])
          .map(p => `${p.date.slice(5)}:${p.bsr ?? "—"}`)
          .join(" ")}`,
        `- 上述 BSR 数字为服务端预计算结果，I3 打分必须直接引用，不得自行编造或重算`
      )
    }
  }
  return lines.join("\n")
}

/** 把六卡证据（A/P/B/C/D/E）拼成 prompt 主体片段（不含开头元信息与结尾指令）。 */
export function buildAuditEvidenceCards(evidence: AuditEvidence): string {
  const { A, P, B, C, D, E } = evidence
  let prompt = ""

  let aBody = formatListingA(A)
  // A1 品牌词机械预检（服务端确定性检查，禁止模型推翻）
  const brandPrecheck = precheckBrandInTitle(A, P)
  if (brandPrecheck) {
    aBody += `\n### A1 品牌词机械预检（确定性问题，禁止推翻）\n${
      brandPrecheck.inTitle
        ? `- 品牌词「${brandPrecheck.brand}」已包含于标题（第 ${brandPrecheck.position ?? "—"} 词）→ 禁止以「标题未包含品牌词」扣分`
        : `- 标题中未检出品牌词「${brandPrecheck.brand}」→ 可按 A1 细则扣品牌分`
    }\n`
  }
  prompt += cardSection("A 卡 · 当前 Listing", aBody)
  prompt += cardSection("P 卡 · 参数信息", formatParamsP(P))
  prompt += cardSection("B 卡 · 评论分析", formatReviewB(B))

  const cLines: string[] = []
  if (C.filled) {
    if (C.competitorAsins?.length) cLines.push(`竞品 ASIN：${C.competitorAsins.join(", ")}`)
    if (C.sharedKeywords?.length) cLines.push(`共有高流量词：${C.sharedKeywords.join(", ")}`)
    if (C.keywords?.length) {
      const kwText = C.keywords
        .slice(0, 20)
        .map(k => `  - ${k.kw}（${k.tier}，月搜索 ${k.searches}）`)
        .join("\n")
      cLines.push(`竞品关键词详情：\n${kwText}`)
    }
  }
  prompt += cardSection(
    "C 卡 · 竞品关键词",
    C.filled && cLines.length ? cLines.join("\n") : `【未取证】${C.missingReason ?? ""}`
  )

  const kwTopJson = D.kwTop?.length ? JSON.stringify(D.kwTop.slice(0, 10), null, 0) : "[]"
  prompt += cardSection(
    "D 卡 · 关键词与流量（SIF）",
    D.filled
      ? [
          `反查词总数：${D.kwStats?.reversed ?? "—"}`,
          `核心词：${D.kwStats?.core ?? "—"} · 自然词：${D.kwStats?.organic ?? "—"} · 广告词：${D.kwStats?.ad ?? "—"} · 机会词：${D.kwStats?.opportunity ?? "—"}`,
          D.summary?.coreCognition ?? "",
          D.summary?.trafficStory ?? "",
          `Top10 流量词：${kwTopJson}`,
          "",
          "### 口径注记（勿违反）",
          "- 查询词中含促销词 / 竞品品牌词 / 他人型号词属正常分析数据：预计算原料（Top10 / 机会词 / 位置表）已剔除确定性禁词；这些词与竞品在用关键词**不是覆盖义务**，listing 未使用不扣分（`for / compatible with` 兼容前缀表述除外）。",
          "- `ranking` 中 `广告无排名` = 该词当前无广告位投放；`广告{N}` = 已有广告位排名（优化阶段广告建议以此为准）。",
          "",
          "### 流量诊断预计算（勿自行编造）",
          formatTrafficPrecompute(D),
        ].join("\n")
      : "【未取证】SIF 流量词缺失"
  )

  prompt += cardSection(
    "E 卡 · ASIN 经营",
    E.filled
      ? [
          `近月购买：${E.boughtInPastMonth ?? "—"}`,
          `Buybox 价：${E.priceBsr.buyboxPrice ?? "—"}`,
          `BSR：${E.priceBsr.bsr ?? "—"}（${E.priceBsr.bsrTrend ?? "—"}）`,
          `Coupon：${E.priceBsr.coupon}`,
          `上架日期：${E.priceBsr.listedDate ?? "—"}`,
          ...(E.adCleaning
            ? [
                "",
                "### 已确认的广告搜索词清洗结果",
                `源文件：${E.adCleaning.originalFilename}`,
                `有效行：${E.adCleaning.stats.effectiveRows} · 聚合搜索词：${E.adCleaning.stats.aggregatedSearchTerms} · 合并重复行：${E.adCleaning.stats.mergedRows} · 跳过行：${E.adCleaning.stats.skippedRows}`,
                `判定计数：可收割 ${E.adCleaning.stats.verdictCounts.good} · 高风险 ${E.adCleaning.stats.verdictCounts.bad} · 待优化 ${E.adCleaning.stats.verdictCounts.warn} · 继续观察 ${E.adCleaning.stats.verdictCounts.watch} · 表现中性 ${E.adCleaning.stats.verdictCounts.neutral}`,
                `待否定词：${E.adCleaning.stats.negativeCandidateCount} 个 · 待否定花费 ${E.adCleaning.stats.currency} ${E.adCleaning.stats.negativeCandidateSpend}`,
                `搜索词审计样本（最多前 30 行）：${JSON.stringify(E.adCleaning.sheetPreviews.find(sheet => sheet.sheetName === "搜索词审计")?.rows.slice(0, 30) ?? [])}`,
                `搜索词审计表头：${JSON.stringify(E.adCleaning.sheetPreviews.find(sheet => sheet.sheetName === "搜索词审计")?.headers ?? [])}`,
              ]
            : ["广告搜索词清洗：未上传或用户暂不分析"]),
        ].join("\n")
      : "【未取证】"
  )

  return prompt
}
