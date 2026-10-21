import { ConflictException, NotFoundException } from "@nestjs/common"
import type { AdCleaningTask } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import { AdCleaningProcessor } from "./ad-cleaning.processor"
import { AdCleaningService } from "./ad-cleaning.service"

describe("AdCleaningService", () => {
  let service: AdCleaningService
  let prisma: {
    adCleaningTask: {
      findFirst: jest.Mock
    }
  }
  let spaces: { downloadBufferByUrl: jest.Mock }

  const successfulTask = (): AdCleaningTask => ({
    id: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    status: "SUCCESS",
    progress: 100,
    stage: "清洗完成",
    originalFilename: "广告报表.xlsx",
    resultFileUrl: "https://files.example.com/ad-cleaning/result.xlsx",
    errorMessage: null,
    startedAt: new Date("2026-08-20T10:00:00.000Z"),
    completedAt: new Date("2026-08-20T10:00:01.000Z"),
    createdAt: new Date("2026-08-20T09:59:59.000Z"),
    updatedAt: new Date("2026-08-20T10:00:01.000Z"),
  })

  beforeEach(() => {
    prisma = {
      adCleaningTask: {
        findFirst: jest.fn(),
      },
    }
    spaces = { downloadBufferByUrl: jest.fn() }
    service = new AdCleaningService(
      prisma as unknown as PrismaService,
      spaces as unknown as SpacesService
    )
  })

  afterEach(() => jest.restoreAllMocks())

  it("成功任务根据结果URL实时读取Sheet预览", async () => {
    prisma.adCleaningTask.findFirst.mockResolvedValue(successfulTask())
    spaces.downloadBufferByUrl.mockResolvedValue(Buffer.from("xlsx"))
    jest.spyOn(AdCleaningProcessor, "inspectResultBuffer").mockReturnValue({
      stats: {
        sourceSheet: "source",
        currency: "USD",
        sourceRows: 1,
        effectiveRows: 1,
        aggregatedSearchTerms: 1,
        mergedRows: 0,
        skippedRows: 0,
        cleanedInvisibleChars: 0,
        trimmedWrappingQuotes: 0,
        zeroImpressionClickRows: 0,
        verdictCounts: { good: 0, bad: 0, warn: 0, watch: 1, neutral: 0 },
        negativeCandidateCount: 0,
        negativeCandidateSpend: 0,
      },
      sheetPreviews: [
        {
          sheetName: "搜索词审计",
          headers: ["客户搜索词"],
          rows: [["laptop"]],
          totalRows: 1,
        },
      ],
    })

    const result = await service.getTask("11111111-1111-4111-8111-111111111111", 7)

    expect(prisma.adCleaningTask.findFirst).toHaveBeenCalledWith({
      where: { taskId: "11111111-1111-4111-8111-111111111111", userId: 7 },
    })
    expect(result).toMatchObject({
      status: "SUCCESS",
      resultFileUrl: "https://files.example.com/ad-cleaning/result.xlsx",
      outputFilename: "广告报表-清洗结果.xlsx",
      sheetPreviews: [
        {
          sheetName: "搜索词审计",
          headers: ["客户搜索词"],
          rows: [["laptop"]],
          totalRows: 1,
        },
      ],
    })
    expect(spaces.downloadBufferByUrl).toHaveBeenCalledWith(
      "https://files.example.com/ad-cleaning/result.xlsx"
    )
  })

  it("连续查询成功任务时每次都重新读取文件，不复用预览缓存", async () => {
    prisma.adCleaningTask.findFirst.mockResolvedValue(successfulTask())
    spaces.downloadBufferByUrl.mockResolvedValue(Buffer.from("xlsx"))
    jest.spyOn(AdCleaningProcessor, "inspectResultBuffer").mockReturnValue({
      stats: {
        sourceSheet: "source",
        currency: "USD",
        sourceRows: 0,
        effectiveRows: 0,
        aggregatedSearchTerms: 0,
        mergedRows: 0,
        skippedRows: 0,
        cleanedInvisibleChars: 0,
        trimmedWrappingQuotes: 0,
        zeroImpressionClickRows: 0,
        verdictCounts: { good: 0, bad: 0, warn: 0, watch: 0, neutral: 0 },
        negativeCandidateCount: 0,
        negativeCandidateSpend: 0,
      },
      sheetPreviews: [],
    })

    await service.getTask("11111111-1111-4111-8111-111111111111", 7)
    await service.getTask("11111111-1111-4111-8111-111111111111", 7)

    expect(spaces.downloadBufferByUrl).toHaveBeenCalledTimes(2)
  })

  it("下载时返回数据库中保存的结果URL", async () => {
    prisma.adCleaningTask.findFirst.mockResolvedValue(successfulTask())

    await expect(service.getResultUrl("11111111-1111-4111-8111-111111111111", 7)).resolves.toBe(
      "https://files.example.com/ad-cleaning/result.xlsx"
    )
  })

  it("未完成任务不能下载", async () => {
    prisma.adCleaningTask.findFirst.mockResolvedValue({
      ...successfulTask(),
      status: "PROCESSING",
      resultFileUrl: null,
    })

    await expect(service.getResultUrl("11111111-1111-4111-8111-111111111111", 7)).rejects.toThrow(
      ConflictException
    )
  })

  it("只能查询当前用户的任务", async () => {
    prisma.adCleaningTask.findFirst.mockResolvedValue(null)

    await expect(service.getTask("missing", 7)).rejects.toThrow(NotFoundException)
  })
})
