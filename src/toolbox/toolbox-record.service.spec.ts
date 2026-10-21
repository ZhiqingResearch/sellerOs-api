import { BadRequestException } from "@nestjs/common"
import { HistoryType } from "@prisma/client"
import { ToolboxRecordService } from "./toolbox-record.service"

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

function createService() {
  const prisma = {
    history: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
    asinEvidenceRecord: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    asinAuditRecord: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    competitorAnalysisRecord: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    selectionAnalysisRecord: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    smartPricingRecord: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    promotionPlanRecord: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
    adCleaningTask: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
  }
  return { service: new ToolboxRecordService(prisma as never), prisma }
}

describe("ToolboxRecordService", () => {
  it("asin_evidence 软删：只删归属集合，非本人/不存在计入 missing", async () => {
    const { service, prisma } = createService()
    prisma.asinEvidenceRecord.findMany.mockResolvedValue([{ id: UUID_A }, { id: UUID_B }])
    prisma.asinEvidenceRecord.updateMany.mockResolvedValue({ count: 2 })

    const result = await service.batchDelete(7, {
      type: "asin_evidence",
      ids: [UUID_A, UUID_B, UUID_C],
    })

    expect(result).toEqual({ deleted: 2, requested: 3, missing: [UUID_C] })
    const findCall = prisma.asinEvidenceRecord.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ]
    expect(findCall[0].where).toMatchObject({
      id: { in: [UUID_A, UUID_B, UUID_C] },
      userId: 7,
      deletedAt: null,
    })
    const updateCall = prisma.asinEvidenceRecord.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: { deletedAt: Date } },
    ]
    expect(updateCall[0].where.id).toEqual({ in: [UUID_A, UUID_B] })
    expect(updateCall[0].data.deletedAt).toBeInstanceOf(Date)
  })

  it("asin_audit 软删时递增 version", async () => {
    const { service, prisma } = createService()
    prisma.asinAuditRecord.findMany.mockResolvedValue([{ id: UUID_A }])
    prisma.asinAuditRecord.updateMany.mockResolvedValue({ count: 1 })

    await service.batchDelete(7, { type: "asin_audit", ids: [UUID_A] })

    const updateCall = prisma.asinAuditRecord.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
    expect(updateCall[0].data.deletedAt).toBeInstanceOf(Date)
    expect(updateCall[0].data.version).toEqual({ increment: 1 })
  })

  it("promotion_plan 硬删 deleteMany 且带 userId", async () => {
    const { service, prisma } = createService()
    prisma.promotionPlanRecord.findMany.mockResolvedValue([{ id: UUID_A }])
    prisma.promotionPlanRecord.deleteMany.mockResolvedValue({ count: 1 })

    const result = await service.batchDelete(7, { type: "promotion_plan", ids: [UUID_A] })

    expect(result.deleted).toBe(1)
    const removeCall = prisma.promotionPlanRecord.deleteMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ]
    expect(removeCall[0].where).toMatchObject({ id: { in: [UUID_A] }, userId: 7 })
  })

  it("listing_generation 按 History.type 限定删除且要求正整数 id", async () => {
    const { service, prisma } = createService()
    prisma.history.findMany.mockResolvedValue([{ id: 3 }, { id: 5 }])
    prisma.history.deleteMany.mockResolvedValue({ count: 2 })

    const result = await service.batchDelete(7, { type: "listing_generation", ids: [3, 5, 9] })

    expect(result).toEqual({ deleted: 2, requested: 3, missing: [9] })
    const findCall = prisma.history.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ]
    expect(findCall[0].where).toMatchObject({
      id: { in: [3, 5, 9] },
      userId: 7,
      type: HistoryType.LISTING_GENERATION,
    })

    await expect(
      service.batchDelete(7, { type: "listing_generation", ids: ["abc"] })
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("listing_scoring 使用 LISTING_SCORING 类型", async () => {
    const { service, prisma } = createService()
    prisma.history.findMany.mockResolvedValue([{ id: 11 }])
    prisma.history.deleteMany.mockResolvedValue({ count: 1 })

    await service.batchDelete(7, { type: "listing_scoring", ids: [11] })

    const findCall = prisma.history.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ]
    expect(findCall[0].where.type).toBe(HistoryType.LISTING_SCORING)
  })

  it("ad_cleaning 按 taskId 删除", async () => {
    const { service, prisma } = createService()
    prisma.adCleaningTask.findMany.mockResolvedValue([{ taskId: UUID_A }])
    prisma.adCleaningTask.deleteMany.mockResolvedValue({ count: 1 })

    const result = await service.batchDelete(7, { type: "ad_cleaning", ids: [UUID_A] })

    expect(result.deleted).toBe(1)
    const findCall = prisma.adCleaningTask.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ]
    expect(findCall[0].where).toMatchObject({ taskId: { in: [UUID_A] }, userId: 7 })
  })

  it("ids 去重后 requested 按去重计", async () => {
    const { service, prisma } = createService()
    prisma.competitorAnalysisRecord.findMany.mockResolvedValue([{ id: UUID_A }])
    prisma.competitorAnalysisRecord.updateMany.mockResolvedValue({ count: 1 })

    const result = await service.batchDelete(7, {
      type: "competitor_analysis",
      ids: [UUID_A, UUID_A],
    })

    expect(result).toEqual({ deleted: 1, requested: 1, missing: [] })
  })

  it("归属集合为空时不发更新且全部计入 missing", async () => {
    const { service, prisma } = createService()
    prisma.selectionAnalysisRecord.findMany.mockResolvedValue([])

    const result = await service.batchDelete(7, {
      type: "product_selection",
      ids: [UUID_A],
    })

    expect(result).toEqual({ deleted: 0, requested: 1, missing: [UUID_A] })
    expect(prisma.selectionAnalysisRecord.updateMany).not.toHaveBeenCalled()
  })

  it("UUID 类型传入非字符串 id → 400", async () => {
    const { service } = createService()
    await expect(
      service.batchDelete(7, { type: "smart_pricing", ids: [123 as unknown as string] })
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("ids 超过 100 → 400", async () => {
    const { service } = createService()
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`)
    await expect(
      service.batchDelete(7, { type: "smart_pricing", ids: ids as unknown as string[] })
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})
