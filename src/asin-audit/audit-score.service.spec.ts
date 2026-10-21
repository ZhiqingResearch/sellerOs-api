import { finalizeScoreResult } from "./audit-score.service"
import { AUDIT_BOARD_CONTRACT } from "./rules/board-contract"
import { parseLlmJson } from "./rules/extract-json"
import type {
  AuditBoard,
  AuditEvidence,
  AuditItemDeduction,
  AuditScoreLlmPayload,
} from "./types/audit.types"

const evidence: AuditEvidence = {
  asin: "B012345678",
  country: "US",
  market: "amazon_us",
  A: { filled: false },
  P: { filled: false },
  B: { filled: false },
  C: { filled: false },
  D: { filled: false, kwTop: [], kwDetail: [] },
  E: {
    filled: false,
    asin: "B012345678",
    boughtInPastMonth: null,
    priceBsr: { buyboxPrice: null, bsr: null, bsrTrend: null, coupon: "", listedDate: null },
  },
  meta: { sources: {}, fetchedAt: "2026-09-08T00:00:00.000Z" },
}

/** 构造合法 boards：默认全部 verified 满分；over 可按项目 id 覆盖 score/status */
function boardsWith(
  over: Record<string, { score?: number | null; status?: "verified" | "pending" | "na" }> = {}
): AuditBoard[] {
  return AUDIT_BOARD_CONTRACT.map(spec => ({
    id: spec.id,
    name: spec.name,
    weight: spec.weight,
    maxScore: spec.maxScore,
    score: 100,
    items: spec.items.map(item => {
      const o = over[item.id]
      const status = o?.status ?? "verified"
      const score = status === "verified" ? (o?.score ?? item.maxScore) : null
      return {
        id: item.id,
        name: item.name,
        maxScore: item.maxScore,
        score,
        status,
        pendingReason: status === "pending" ? "证据不足" : null,
        naReason: status === "na" ? "类目不适用" : null,
        deductions:
          status === "verified" && score != null && score < item.maxScore
            ? [
                {
                  reason: `扣 ${item.maxScore - score} 分 · 当前 ${score}/${item.maxScore}`,
                  points: item.maxScore - score,
                },
              ]
            : [],
      }
    }),
  }))
}

const payload = (
  over?: Record<string, { score?: number | null; status?: "verified" | "pending" | "na" }>
): AuditScoreLlmPayload => ({
  boards: boardsWith(over),
  diagnosis: { weakestBoards: ["F"], contentNarrative: "…", operationsNarrative: "…", issues: [] },
  suggestions: ["建议 1"],
})

describe("finalizeScoreResult（v2.0 十板块）", () => {
  it("全核验满分：V=A=100，total=100 EXCELLENT，板块/域分满分", () => {
    const r = finalizeScoreResult(payload(), evidence)
    expect(r.total).toBe(100)
    expect(r.grade).toBe("EXCELLENT")
    expect(r.gradeLabel).toBe("优秀")
    expect(r.scoring).toMatchObject({
      applicableMax: 100,
      evidenceMax: 100,
      earnedScore: 100,
      convertedScore: 100,
      coverageRate: 1,
      isComplete: true,
    })
    expect(r.domainScores).toEqual({ content: 100, operations: 100 })
    expect(r.boards).toHaveLength(10)
    expect(r.boards.every(b => b.items.length > 0)).toBe(true)
  })

  it("归档兼容摘要：附带 overallScore/contentScore/trafficScore；广告分从 adDiagnostics 提取，未上传缺省", () => {
    const withAds = finalizeScoreResult({ ...payload(), adDiagnostics: { score: 62 } }, evidence)
    expect(withAds.overallScore).toBe(100)
    expect(withAds.contentScore).toBe(100)
    expect(withAds.trafficScore).toBe(100)
    expect(withAds.adScore).toBe(62)

    const withoutAds = finalizeScoreResult(payload(), evidence)
    expect(withoutAds.adScore).toBeUndefined()
    expect(withoutAds.overallScore).toBe(100)
  })

  it("广告分回写 adDiagnostics 顶层 score（前端归档预检只认该处 score/total/overallScore）", () => {
    // 模型只给 dimensions：加权结果回写为顶层 score
    const dimsOnly = finalizeScoreResult(
      {
        ...payload(),
        adDiagnostics: {
          dimensions: [
            { weight: 24, score: 55 },
            { weight: 22, score: 48 },
            { weight: 20, score: 78 },
            { weight: 18, score: 70 },
            { weight: 16, score: 65 },
          ],
        },
      },
      evidence
    )
    expect(dimsOnly.adScore).toBe(62.36)
    expect(dimsOnly.adDiagnostics).toMatchObject({ score: 62.36 })

    // 越界值（120）钳制后回写，前端预检不再判无效
    const overflow = finalizeScoreResult(
      { ...payload(), adDiagnostics: { score: 120, findings: ["x"] } },
      evidence
    )
    expect(overflow.adScore).toBe(100)
    expect(overflow.adDiagnostics).toMatchObject({ score: 100, findings: ["x"] })

    // 顶层 total 兜底（前端同序）+ 已有合法 score 时回写为同值（无副作用）
    const byTotal = finalizeScoreResult({ ...payload(), adDiagnostics: { total: 58 } }, evidence)
    expect(byTotal.adScore).toBe(58)
    expect(byTotal.adDiagnostics).toMatchObject({ score: 58, total: 58 })
  })

  it("归档兼容摘要：total=null（覆盖率不足）用折算分兜底", () => {
    const r = finalizeScoreResult(
      payload({
        F1: { status: "pending" },
        F2: { status: "pending" },
        F3: { status: "pending" },
        E1: { status: "pending" },
        E2: { status: "pending" },
        E3: { status: "pending" },
        G1: { status: "pending" },
        G3: { status: "pending" },
      }),
      evidence
    )
    expect(r.total).toBeNull()
    expect(r.overallScore).toBe(r.scoring.convertedScore)
  })

  it("待核项：score=null、权重留 A 不进 V，折算分按有效证据重算", () => {
    // F1(12) + I3(8) 共 20 分待核 → A=100 V=80；F1 本来满分所以 E 仍 88
    const r = finalizeScoreResult(
      payload({ F1: { status: "pending" }, I3: { status: "pending" } }),
      evidence
    )
    expect(r.scoring.applicableMax).toBe(100)
    expect(r.scoring.evidenceMax).toBe(80)
    expect(r.scoring.coverageRate).toBe(0.8)
    expect(r.scoring.isComplete).toBe(false)
    expect(r.total).toBe(100) // 覆盖率 80% ≥60%，仍出总分
    expect(r.scoring.convertedScore).toBe(100)
    expect(r.boards.find(b => b.id === "I")?.items[0]?.score).toBeNull()
  })

  it("覆盖率 <60% 不出总分：total=null，但折算分保留", () => {
    // 待核 F1+F2+F3+E1+E2+E3+G1+G3 = 12+3+5+6+4+2+8+6 = 46 → V=54，覆盖率 0.54
    const r = finalizeScoreResult(
      payload({
        F1: { status: "pending" },
        F2: { status: "pending" },
        F3: { status: "pending" },
        E1: { status: "pending" },
        E2: { status: "pending" },
        E3: { status: "pending" },
        G1: { status: "pending" },
        G3: { status: "pending" },
      }),
      evidence
    )
    expect(r.scoring.coverageRate).toBe(0.54)
    expect(r.total).toBeNull()
    expect(r.scoring.convertedScore).toBe(100) // 剩余已核验项仍满分
  })

  it("N/A 项从 A 与 V 同时剔除；扣分项重算板块得分", () => {
    // E2(4) N/A → A=96；F1 扣 2 → E=94（100 − 4 − 2）
    const r = finalizeScoreResult(payload({ E2: { status: "na" }, F1: { score: 10 } }), evidence)
    expect(r.scoring.applicableMax).toBe(96)
    expect(r.scoring.evidenceMax).toBe(96)
    expect(r.scoring.earnedScore).toBe(94)
    expect(r.scoring.convertedScore).toBeCloseTo((100 * 94) / 96, 1) // 97.92
    expect(r.boards.find(b => b.id === "F")?.score).toBeCloseTo(((10 + 3 + 5) / 20) * 100) // 90
  })

  it("等级分档：70→GOOD、85→EXCELLENT、50→FAIR、49→POOR（由服务端按折算分计算）", () => {
    // 扣 30 分（F1 12 + F2 3 + F3 5 + G1 8 + C3 1 + B1 1 = 30）→ 70 GOOD
    const g70 = finalizeScoreResult(
      payload({
        F1: { score: 0 },
        F2: { score: 0 },
        F3: { score: 0 },
        G1: { score: 0 },
        C3: { score: 0 },
        B1: { score: 1 },
      }),
      evidence
    )
    expect(g70.total).toBe(70)
    expect(g70.grade).toBe("GOOD")
  })

  it("契约校验：结构错误（板块数不对/权重错/项目 id 错）→ 抛错不伪成功", () => {
    const missing = { ...payload(), boards: boardsWith().slice(0, 9) }
    expect(() => finalizeScoreResult(missing, evidence)).toThrow(/expected 10 boards/)

    const wrongWeight = boardsWith()
    wrongWeight[0].weight = 99
    expect(() => finalizeScoreResult({ boards: wrongWeight }, evidence)).toThrow(
      /weight\/maxScore mismatch/
    )

    const wrongItemId = boardsWith()
    ;(wrongItemId[0].items[0] as { id: string }).id = "ZZ"
    expect(() => finalizeScoreResult({ boards: wrongItemId }, evidence)).toThrow(/expected id=A1/)
  })

  it("值级矛盾矫正（不报错）：pending 带 score（E3 写 0）→ 置 null；verified 越界 → 钳制", () => {
    // E3 pending 却写 0（模型高频噪音）：信任 status，丢弃分数
    const noisy = boardsWith({ E3: { status: "pending" } })
    ;(noisy.find(b => b.id === "E")!.items[2] as unknown as { score: number }).score = 0
    const r = finalizeScoreResult({ boards: noisy }, evidence)
    const e3 = r.boards.find(b => b.id === "E")!.items.find(it => it.id === "E3")
    expect(e3?.score).toBeNull()
    expect(e3?.status).toBe("pending")
    // E3(2) 转待核 → V=98
    expect(r.scoring.evidenceMax).toBe(98)

    // verified 越界 99 → 钳到 max 5
    const overflow = boardsWith({ A1: { score: 99 } })
    const r2 = finalizeScoreResult({ boards: overflow }, evidence)
    expect(r2.boards[0].items[0].score).toBe(5)
  })

  it("标题违禁词合规门：命中 → total=0 + POOR + severeDefects", () => {
    const gated: AuditEvidence = {
      ...evidence,
      A: { filled: true, title: "#1 best seller free shipping" },
    }
    const r = finalizeScoreResult(payload(), gated)
    expect(r.total).toBe(0)
    expect(r.grade).toBe("POOR")
    expect(r.severeDefects?.length).toBeGreaterThan(0)
  })

  it("trafficSuggestions 已暂时下线：评分结果不再输出该字段", () => {
    const r = finalizeScoreResult(payload(), evidence)
    expect(r.trafficSuggestions).toBeUndefined()
  })

  it("修复模型字符串中未转义的双引号（parseLlmJson + jsonrepair）", () => {
    const raw = JSON.stringify({ historyTitle: 'Listing "Easy Setup" audit' }).replace(
      '\\"Easy Setup\\"',
      '"Easy Setup"'
    )
    expect(parseLlmJson<{ historyTitle: string }>(raw).historyTitle).toBe(
      'Listing "Easy Setup" audit'
    )
  })
})

describe("deduction 归属/事实护栏（v2.2）", () => {
  /** 把自定义 deductions（与可选 score）写到指定项目上 */
  function withItem(
    base: AuditScoreLlmPayload,
    itemId: string,
    deductions: AuditItemDeduction[],
    score?: number
  ): AuditScoreLlmPayload {
    const boards = base.boards!.map(b => ({ ...b, items: b.items.map(it => ({ ...it })) }))
    const item = boards.flatMap(b => b.items).find(it => it.id === itemId)!
    item.deductions = deductions
    if (score !== undefined) item.score = score
    return { ...base, boards }
  }

  const itemOf = (r: { boards: AuditBoard[] }, itemId: string) =>
    r.boards.flatMap(b => b.items).find(it => it.id === itemId)!

  it("E1 视频扣分（唯一归属 E3）：丢弃并返还，非视频 deduction 保留", () => {
    const p = withItem(
      payload(),
      "E1",
      [
        { reason: "未提供视频演示，扣 1 分 · 当前 4.5/6", points: 1 },
        { reason: "尺寸信息缺失，扣 0.5 分 · 当前 4.5/6", points: 0.5 },
      ],
      4.5
    )
    const r = finalizeScoreResult(p, evidence)
    const e1 = itemOf(r, "E1")
    expect(e1.score).toBe(5.5) // 返还视频误扣的 1 分
    expect(e1.deductions).toHaveLength(1)
    expect(e1.deductions[0]?.reason).toMatch(/尺寸/)
    expect(r.scoring.earnedScore).toBe(99.5)
  })

  it("E3 自己的视频扣分不受影响（唯一 owner）", () => {
    const p = withItem(
      payload(),
      "E3",
      [{ reason: "无产品视频，扣 2 分 · 当前 0/2", points: 2 }],
      0
    )
    const r = finalizeScoreResult(p, evidence)
    const e3 = itemOf(r, "E3")
    expect(e3.score).toBe(0)
    expect(e3.deductions).toHaveLength(1)
  })

  it("E2 任何扣分均越界（默认满分）：丢弃并返还", () => {
    const p = withItem(
      payload(),
      "E2",
      [{ reason: "未做 A+ 页面，扣 2 分 · 当前 2/4", points: 2 }],
      2
    )
    const r = finalizeScoreResult(p, evidence)
    const e2 = itemOf(r, "E2")
    expect(e2.score).toBe(4)
    expect(e2.deductions).toHaveLength(0)
  })

  it("A1 品牌误判（预检确认标题含品牌词）：扣分丢弃并返还，其他 deduction 保留", () => {
    const withBrand: AuditEvidence = {
      ...evidence,
      A: {
        filled: true,
        title: 'Lenovo IdeaPad Slim 3i 15.6" FHD Laptop Computer, Quad-Core Intel N150',
        brand: "Lenovo",
      },
    }
    const p = withItem(
      payload(),
      "A1",
      [
        { reason: "标题未包含品牌词 Lenovo，扣 1 分 · 当前 3/5", points: 1 },
        { reason: "标题未包含核心配置 RAM/存储信息（扣 1 分 · 当前 3/5）", points: 1 },
      ],
      3
    )
    const r = finalizeScoreResult(p, withBrand)
    const a1 = itemOf(r, "A1")
    expect(a1.score).toBe(4) // 5 − 品牌误扣 1（返还）− RAM 1（保留）= 4
    expect(a1.deductions).toHaveLength(1)
    expect(a1.deductions[0]?.reason).toMatch(/RAM/)
  })

  it("A1 无品牌预检（无 brand 数据）→ 不拦截，deduction 原样保留", () => {
    const p = withItem(
      payload(),
      "A1",
      [{ reason: "标题未包含品牌词，扣 1 分 · 当前 3/5", points: 1 }],
      3
    )
    const r = finalizeScoreResult(p, evidence)
    const a1 = itemOf(r, "A1")
    expect(a1.score).toBe(3)
    expect(a1.deductions).toHaveLength(1)
  })

  it("待核项的越界 deduction：丢弃但不返还（score 保持 null）", () => {
    const p = withItem(payload({ E1: { status: "pending" } }), "E1", [
      { reason: "未提供视频演示，扣 1 分", points: 1 },
    ])
    const r = finalizeScoreResult(p, evidence)
    const e1 = itemOf(r, "E1")
    expect(e1.status).toBe("pending")
    expect(e1.score).toBeNull()
    expect(e1.deductions).toHaveLength(0)
  })
})
