import {
  asinAuditStageRecords,
  AuditUsageLog,
  linkAsinAuditUsage,
} from "./asin-audit-generation-records"

const savedAt = new Date("2026-10-30T08:36:47.260Z")
const report = {
  id: "report-1",
  userId: 74,
  asin: "B012345678",
  productTitle: "商品",
  clientRequestId: "save-request",
  createdAt: new Date("2026-10-29"),
  deletedAt: null,
  scoreSnapshot: { createdAt: new Date("2026-10-29") },
  optimizationRevisions: [{ revision: 1, createdAt: savedAt }],
}
const log: AuditUsageLog = {
  id: 12837,
  userId: 74,
  source: "asin.audit",
  requestId: "charge:asin-audit:optimize:uuid",
  meta: { stage: "optimize", clientRequestId: "generation-request" },
  createdAt: new Date("2026-10-30T08:36:46.461Z"),
}

describe("ASIN 审计阶段关联", () => {
  it("优化关联对应保存版本，不使用一天前的主报告时间", () => {
    const stages = asinAuditStageRecords([report])
    expect(stages.map(row => row.key)).toEqual([
      "TEXT:ASIN_AUDIT:report-1:score",
      "TEXT:ASIN_AUDIT:report-1:optimize",
    ])
    expect(linkAsinAuditUsage(stages, [log]).get(12837)).toBe(stages[1])
    expect(stages[1].createdAt).toEqual(savedAt)
  })

  it("同用户同阶段有两个可能报告时不任意选一个", () => {
    const stages = asinAuditStageRecords([
      report,
      { ...report, id: "report-2", clientRequestId: "other-save" },
    ])
    expect(linkAsinAuditUsage(stages, [log]).size).toBe(0)
  })

  it("一份保存版本附近存在两笔扣费时不凭时间重复归属", () => {
    const stages = asinAuditStageRecords([report])
    expect(linkAsinAuditUsage(stages, [log, { ...log, id: 12838 }]).size).toBe(0)
  })

  it("明确报告 ID 优先，可跨时间关联且不被另一个 clientRequestId 覆盖", () => {
    const stages = asinAuditStageRecords([
      report,
      { ...report, id: "report-2", clientRequestId: "other-save" },
    ])
    const explicit = {
      ...log,
      createdAt: new Date("2026-11-01"),
      meta: { stage: "score", recordId: "report-1", clientRequestId: "other-save" },
    }
    expect(linkAsinAuditUsage(stages, [explicit]).get(12837)).toBe(stages[0])
  })

  it("明确报告不存在、用户不匹配或新指纹尚未关联时不回落猜测", () => {
    const stages = asinAuditStageRecords([report])
    for (const value of [
      { ...log, meta: { stage: "optimize", recordId: "missing" } },
      { ...log, userId: 75, meta: { stage: "optimize", recordId: "report-1" } },
      { ...log, meta: { stage: "optimize", resultHash: "not-saved" } },
    ])
      expect(linkAsinAuditUsage(stages, [value]).size).toBe(0)
  })

  it("未知阶段、先存后扣和超过兼容窗口的流水保留未关联", () => {
    const stages = asinAuditStageRecords([report])
    for (const value of [
      { ...log, requestId: null, meta: { asin: report.asin } },
      { ...log, createdAt: new Date(savedAt.getTime() + 1) },
      { ...log, createdAt: new Date(savedAt.getTime() - 10001) },
    ])
      expect(linkAsinAuditUsage(stages, [value]).size).toBe(0)
  })

  it("已精确关联的保存事件不会再吸附附近另一笔流水", () => {
    const stages = asinAuditStageRecords([report])
    const exact = { ...log, id: 1, meta: { stage: "optimize", recordId: report.id } }
    const matches = linkAsinAuditUsage(stages, [exact, log])
    expect([...matches.keys()]).toEqual([1])
  })
})
