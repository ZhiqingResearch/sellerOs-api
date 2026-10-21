import type { TrafficPrecompute } from "../types/de.types"
import { buildTrafficSuggestionsFromPrecompute } from "./traffic-suggestions"

const basePc: TrafficPrecompute = {
  top10Page1Hits: 8,
  homepageHitTier: { score: 5, max: 5, label: "7~10 个首页命中" },
  weightedNaturalPct: 70,
  naturalHealthTier: { score: 4, max: 4, label: "加权自然占比 70%" },
  opportunityCount: 0,
  top1ConcentrationPct: 18,
  concentrationTier: { score: 3, max: 3, label: "Top1 贡献 18%" },
  summaryLines: [],
}

function findByRule(
  rules: ReturnType<typeof buildTrafficSuggestionsFromPrecompute>,
  ruleId: string
) {
  return rules?.find(r => r.ruleId === ruleId)
}

describe("buildTrafficSuggestionsFromPrecompute · I3（v2.2 BSR 口径）", () => {
  it("无预计算 → 待核", () => {
    const i3 = findByRule(buildTrafficSuggestionsFromPrecompute(undefined), "I3")
    expect(i3?.level).toBe("pending")
  })

  it("预计算无 bsrTrend → 待核（日级序列不足）", () => {
    const i3 = findByRule(buildTrafficSuggestionsFromPrecompute(basePc), "I3")
    expect(i3?.level).toBe("pending")
    expect(i3?.summary).toMatch(/日级排名序列不足/)
  })

  it("bsrTrend 待核原因透传", () => {
    const i3 = findByRule(
      buildTrafficSuggestionsFromPrecompute({
        ...basePc,
        bsrTrend: {
          available: false,
          reason: "近 14 天 BSR 日级序列不足（有效 6/14 天，前 7 天 3 天、后 7 天 3 天）",
          windowDays: 14,
          validDays: 6,
          prev7AvgBsr: null,
          last7AvgBsr: null,
          retainedPct: null,
          declinedDays: 0,
          tier: { score: 0, max: 8, label: "数据不足" },
        },
      }),
      "I3"
    )
    expect(i3?.level).toBe("pending")
    expect(i3?.summary).toMatch(/有效 6\/14 天/)
  })

  it("有数据：按扣分分级并带数字 summary（扣 4 → important）", () => {
    const i3 = findByRule(
      buildTrafficSuggestionsFromPrecompute({
        ...basePc,
        bsrTrend: {
          available: true,
          windowDays: 14,
          validDays: 14,
          prev7AvgBsr: 100,
          last7AvgBsr: 165,
          retainedPct: 60.6,
          declinedDays: 3,
          tier: { score: 4, max: 8, label: "…" },
        },
      }),
      "I3"
    )
    expect(i3?.level).toBe("important")
    expect(i3?.deducted).toBe(4)
    expect(i3?.summary).toMatch(/保持率 60\.6%/)
    expect(i3?.summary).toMatch(/连续劣于基线 3 天/)
  })

  it("满分（改善封顶）→ ok 一行 ✅；重扣（≥5）→ urgent", () => {
    const ok = findByRule(
      buildTrafficSuggestionsFromPrecompute({
        ...basePc,
        bsrTrend: {
          available: true,
          windowDays: 14,
          validDays: 14,
          prev7AvgBsr: 100,
          last7AvgBsr: 90,
          retainedPct: 100,
          declinedDays: 0,
          tier: { score: 8, max: 8, label: "…" },
        },
      }),
      "I3"
    )
    expect(ok?.level).toBe("ok")
    expect(ok?.deducted).toBe(0)

    const urgent = findByRule(
      buildTrafficSuggestionsFromPrecompute({
        ...basePc,
        bsrTrend: {
          available: true,
          windowDays: 14,
          validDays: 14,
          prev7AvgBsr: 100,
          last7AvgBsr: 400,
          retainedPct: 25,
          declinedDays: 6,
          tier: { score: 2, max: 8, label: "…" },
        },
      }),
      "I3"
    )
    expect(urgent?.level).toBe("urgent")
    expect(urgent?.deducted).toBe(6)
  })
})
