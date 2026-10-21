import { ConflictException, NotFoundException } from "@nestjs/common"
import { Prisma, type VideoAnalysisRecord } from "@prisma/client"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { PaginationDto } from "../common/dto/pagination.dto"
import { hashJson } from "../common/utils/canonical-json"
import { PrismaService } from "../prisma/prisma.service"
import { VideoAnalysisDto } from "./dto/video-analysis.dto"
import { VideoAnalysisRecordService, VideoAnalysisSnapshot } from "./video-analysis-record.service"
import { normalizeVideoAnalysisResult } from "./video-analysis.normalize"

const recordId = "48efab82-71c1-4d4e-a626-5bc0ac351e53"
const model = "ZQ-Multimodal-Gemini-3.5-Flash-Lite"
const dto: VideoAnalysisDto = {
  videoUrl: "https://cdn.example.com/video.mp4",
  duration: 30,
  chargeRequestId: "video-analysis-0f1e2d3c-4b5a-6789-abcd-ef0123456789",
  focus: "  开场钩子  ",
}
const input = {
  videoUrl: dto.videoUrl,
  duration: 30,
  focus: "开场钩子",
  mimeType: "video/mp4",
  model,
}
const snapshot: VideoAnalysisSnapshot = {
  result: normalizeVideoAnalysisResult({ title: "开箱视频", overview: "概览" }, 30, true),
  usage: { promptTokens: 4000, completionTokens: 100, thinkingTokens: 0, totalTokens: 4100 },
  usageDetail: { videoInputTokens: 3000, audioInputTokens: 500, textInputTokens: 500 },
  charge: {
    type: "charge",
    ok: true,
    creditsCharged: "5",
    balance: "120",
    costCny: "0.5",
    breakdown: [],
  },
}
const row: VideoAnalysisRecord = {
  id: recordId,
  userId: 7,
  chargeRequestId: dto.chargeRequestId,
  fingerprint: hashJson(input),
  title: "开箱视频",
  ...input,
  result: snapshot.result as unknown as Prisma.JsonObject,
  usage: snapshot.usage,
  usageDetail: snapshot.usageDetail,
  charge: snapshot.charge,
  createdAt: new Date("2026-10-07T00:00:00Z"),
  deletedAt: null,
}

describe("VideoAnalysisRecordService", () => {
  let delegate: {
    upsert: jest.Mock
    findMany: jest.Mock
    count: jest.Mock
    findFirst: jest.Mock
    updateMany: jest.Mock
  }
  let service: VideoAnalysisRecordService
  let queryRaw: jest.Mock

  beforeEach(() => {
    delegate = {
      upsert: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    }
    queryRaw = jest.fn().mockResolvedValue([])
    service = new VideoAnalysisRecordService({
      videoAnalysisRecord: delegate,
      $queryRaw: queryRaw,
    } as unknown as PrismaService)
  })

  it("保存规范化输入、完整报告、用量与扣费状态，不覆盖首次快照", async () => {
    const saved = await service.save(7, dto, model, snapshot)
    expect(saved).toMatchObject({ recordId, ...input, ...snapshot })
    expect(delegate.upsert).toHaveBeenCalledWith({
      where: { userId_chargeRequestId: { userId: 7, chargeRequestId: dto.chargeRequestId } },
      create: {
        userId: 7,
        chargeRequestId: dto.chargeRequestId,
        fingerprint: hashJson(input),
        title: "开箱视频",
        ...input,
        ...snapshot,
      },
      update: {},
    })
    const concurrentResult = await service.save(7, dto, model, {
      ...snapshot,
      result: { ...snapshot.result, title: "另一个结果" },
    })
    expect(concurrentResult.result.title).toBe("开箱视频")
  })

  it("并发撞唯一键时重读同用户同请求的首次结果", async () => {
    delegate.upsert.mockRejectedValue(
      new PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6.19.3" })
    )
    queryRaw.mockResolvedValue([row])
    await expect(service.save(7, dto, model, snapshot)).resolves.toMatchObject({
      recordId,
      result: snapshot.result,
    })
    expect(queryRaw).toHaveBeenCalledWith(expect.any(Array) as unknown, 7, dto.chargeRequestId)
  })

  it("未知数据库错误原样抛出，不伪装成保存成功", async () => {
    delegate.upsert.mockRejectedValue(new Error("db unavailable"))
    await expect(service.save(7, dto, model, snapshot)).rejects.toThrow("db unavailable")
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it("同键重试直接返回保存快照；同键不同视频或模型拒绝重放", async () => {
    queryRaw.mockResolvedValue([row])
    await expect(service.findReplay(7, dto, model)).resolves.toMatchObject({
      recordId,
      result: snapshot.result,
    })
    await expect(
      service.findReplay(7, { ...dto, videoUrl: "https://cdn.example.com/other.mp4" }, model)
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(service.findReplay(7, dto, "other-model")).rejects.toBeInstanceOf(
      ConflictException
    )
  })

  it("已删除记录不能重放或重新保存恢复", async () => {
    queryRaw.mockResolvedValue([{ ...row, deletedAt: new Date() }])
    delegate.upsert.mockResolvedValue({ ...row, deletedAt: new Date() })
    await expect(service.findReplay(7, dto, model)).rejects.toThrow("视频分析记录已删除")
    await expect(service.save(7, dto, model, snapshot)).rejects.toThrow("视频分析记录已删除")
  })

  it("分页只查本人未删除记录，返回摘要不携带完整 result", async () => {
    const { id, title, videoUrl, duration, model: savedModel, charge, createdAt } = row
    delegate.findMany.mockResolvedValue([
      { id, title, videoUrl, duration, model: savedModel, charge, createdAt },
    ])
    delegate.count.mockResolvedValue(21)
    const result = await service.findAll(7, { page: 2, pageSize: 10 })
    expect(result).toMatchObject({
      items: [{ recordId }],
      total: 21,
      page: 2,
      pageSize: 10,
      totalPages: 3,
    })
    expect(result.items[0]).not.toHaveProperty("result")
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, deletedAt: null },
        skip: 10,
        take: 10,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }) as unknown
    )
    expect(delegate.count).toHaveBeenCalledWith({ where: { userId: 7, deletedAt: null } })
    delegate.count.mockResolvedValue(0)
    delegate.findMany.mockResolvedValue([])
    await expect(service.findAll(7, new PaginationDto())).resolves.toMatchObject({
      total: 0,
      totalPages: 0,
    })
  })

  it("详情按用户与删除状态隔离：不存在、他人或已删除一律 404", async () => {
    delegate.findFirst.mockResolvedValue(row)
    await expect(service.findOne(7, recordId)).resolves.toMatchObject({
      recordId,
      result: snapshot.result,
      usage: snapshot.usage,
      charge: snapshot.charge,
    })
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { id: recordId, userId: 7, deletedAt: null },
    })
    delegate.findFirst.mockResolvedValue(null)
    await expect(service.findOne(8, recordId)).rejects.toBeInstanceOf(NotFoundException)
    expect(delegate.findFirst).toHaveBeenLastCalledWith({
      where: { id: recordId, userId: 8, deletedAt: null },
    })
  })

  it("软删除以 userId 原子限制，删除他人或已删除记录返回 404", async () => {
    delegate.updateMany.mockResolvedValue({ count: 1 })
    await service.remove(7, recordId)
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { id: recordId, userId: 7, deletedAt: null },
      data: { deletedAt: expect.any(Date) as unknown },
    })
    delegate.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.remove(8, recordId)).rejects.toBeInstanceOf(NotFoundException)
  })
})
