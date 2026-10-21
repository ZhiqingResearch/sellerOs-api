import { ForbiddenException } from "@nestjs/common"
import { SelectionAnalysisEntry } from "@prisma/client"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { PrismaService } from "../prisma/prisma.service"
import { AnalysisRecordController } from "./analysis-record.controller"
import { AnalysisRecordService } from "./analysis-record.service"

function getFirstQuery(mock: jest.Mock): unknown {
  const calls = mock.mock.calls as unknown[][]
  return calls[0]?.[0]
}

describe("统一选品历史", () => {
  const createStore = () => ({
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  })
  let prisma: {
    selectionAnalysisRecord: ReturnType<typeof createStore>
    categoryAnalysisRecord: ReturnType<typeof createStore>
  }
  let service: AnalysisRecordService
  const access = { hasSelectionAccess: true, hasCategoryAccess: true }
  const query = { page: 1, pageSize: 2, includeCategoryAnalysis: true }
  beforeEach(() => {
    prisma = { selectionAnalysisRecord: createStore(), categoryAnalysisRecord: createStore() }
    service = new AnalysisRecordService(prisma as unknown as PrismaService)
  })
  const legacy = (id: string, day: number) => ({
    id,
    entry: SelectionAnalysisEntry.CATALOG,
    marketplace: "US",
    primaryCategoryName: id,
    primaryCategoryPath: null,
    lastCompletedStep: 1,
    pickCount: 0,
    status: "COMPLETED",
    version: 1,
    createdAt: new Date(`2026-09-${day}T00:00:00Z`),
    updatedAt: new Date(`2026-09-${day}T00:00:00Z`),
  })
  const category = (id: number, day: number) => ({
    id,
    marketplace: "US",
    title: String(id),
    status: "COMPLETED",
    createdAt: new Date(`2026-09-${day}T00:00:00Z`),
    updatedAt: new Date(`2026-09-${day}T00:00:00Z`),
  })

  it("merges source prefixes before paginating so later pages do not skip records", async () => {
    const legacyRows = [legacy("old-1", 16), legacy("old-2", 12), legacy("old-3", 10)]
    const categoryRows = [category(3, 15), category(2, 14), category(1, 11)]
    prisma.selectionAnalysisRecord.findMany.mockImplementation(({ take }: { take: number }) =>
      legacyRows.slice(0, take)
    )
    prisma.categoryAnalysisRecord.findMany.mockImplementation(({ take }: { take: number }) =>
      categoryRows.slice(0, take)
    )
    prisma.selectionAnalysisRecord.count.mockResolvedValue(3)
    prisma.categoryAnalysisRecord.count.mockResolvedValue(3)
    const pages = await Promise.all(
      [1, 2, 3].map(page => service.findAll(7, { ...query, page }, access))
    )
    expect(pages.flatMap(page => page.items.map(item => item.analysisId))).toEqual([
      "old-1",
      "category:3",
      "category:2",
      "old-2",
      "category:1",
      "old-3",
    ])
    expect(pages.map(page => page.total)).toEqual([6, 6, 6])
    expect(prisma.selectionAnalysisRecord.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: 4 })
    )
  })

  it("filters both sources before pagination and excludes deleted or other users' rows", async () => {
    await service.findAll(
      7,
      {
        ...query,
        entry: SelectionAnalysisEntry.CATALOG,
        keyword: " Storage ",
        marketplace: " us ",
      },
      access
    )
    const selectionQuery = getFirstQuery(prisma.selectionAnalysisRecord.findMany)
    expect(selectionQuery).toMatchObject({
      where: {
        userId: 7,
        deletedAt: null,
        marketplace: "US",
        entry: "CATALOG",
      },
    })
    const categoryQuery = getFirstQuery(prisma.categoryAnalysisRecord.findMany)
    expect(categoryQuery).toMatchObject({
      where: {
        userId: 7,
        deletedAt: null,
        marketplace: "US",
        OR: [{ marketplace: { contains: "Storage" } }, { title: { contains: "Storage" } }],
      },
    })
  })

  it("never queries a source that the user cannot access", async () => {
    await service.findAll(7, query, { hasSelectionAccess: false, hasCategoryAccess: true })
    expect(prisma.selectionAnalysisRecord.findMany).not.toHaveBeenCalled()
    expect(prisma.selectionAnalysisRecord.count).not.toHaveBeenCalled()
    prisma.categoryAnalysisRecord.findMany.mockClear()
    await service.findAll(7, query, { hasSelectionAccess: true, hasCategoryAccess: false })
    expect(prisma.categoryAnalysisRecord.findMany).not.toHaveBeenCalled()
  })

  it("does not include categories in the original product filter", async () => {
    await service.findAll(7, { ...query, entry: SelectionAnalysisEntry.PRODUCT }, access)
    expect(prisma.categoryAnalysisRecord.findMany).not.toHaveBeenCalled()
    const selectionQuery = getFirstQuery(prisma.selectionAnalysisRecord.findMany)
    expect(selectionQuery).toMatchObject({ where: { entry: "PRODUCT" } })
  })
})

describe("统一历史独立权限", () => {
  const req = { user: { id: 7 } }
  const query = { page: 1, pageSize: 20, includeCategoryAnalysis: true }
  const getForUser = jest.fn()
  const findAll = jest.fn().mockResolvedValue({ items: [] })
  const controller = new AnalysisRecordController(
    { findAll } as unknown as AnalysisRecordService,
    { getForUser } as unknown as PermissionCacheService
  )
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ["tool.category_analysis", false, true],
    ["tool.flow_workbench", true, false],
    ["tool", true, true],
  ])(
    "restricts %s to its authorized history sources",
    async (permission, hasSelectionAccess, hasCategoryAccess) => {
      getForUser.mockResolvedValue(new Set([permission]))
      await controller.findAll(req, query)
      expect(findAll).toHaveBeenCalledWith(7, query, { hasSelectionAccess, hasCategoryAccess })
    }
  )

  it("rejects users without either feature permission", async () => {
    getForUser.mockResolvedValue(new Set())
    await expect(controller.findAll(req, query)).rejects.toBeInstanceOf(ForbiddenException)
    expect(findAll).not.toHaveBeenCalled()
  })

  it("keeps the original query restricted to product selection access", async () => {
    getForUser.mockResolvedValue(new Set(["tool.category_analysis"]))
    await expect(controller.findAll(req, { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(
      ForbiddenException
    )
  })
})
