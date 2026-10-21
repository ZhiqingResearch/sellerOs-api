import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import type { Prisma, RpaCreationTask } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { CreateRpaCreationTaskDto } from "./rpa-creation.dto"
import { RpaCreationService } from "./rpa-creation.service"

interface OutputRow {
  id: number
  taskId: number
  status: string
  task: { mediaType: string; status: string }
}

describe("RPA 模型参数与派发", () => {
  const video: CreateRpaCreationTaskDto = {
    mediaType: "VIDEO",
    model: "OMNI_1_1_FLASH",
    prompt: "测试视频",
    aspectRatio: "16:9",
    quantity: 2,
    durationSec: 8,
  }

  function setup() {
    const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      rpaCreationProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
      rpaCreationTask: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Prisma.RpaCreationTaskUncheckedCreateInput }) => ({
            ...data,
            id: 10,
            outputs: [],
          })),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    }
    const config = { get: jest.fn().mockReturnValue("https://api.example.com") }
    const yingdao = {
      uploadFile: jest.fn().mockResolvedValue({ fileKey: "params.txt" }),
      startTask: jest.fn().mockResolvedValue({ taskUuid: "yingdao-10", jobUuidList: [] }),
    }
    const service = new RpaCreationService(
      prisma as never,
      config as never,
      {} as never,
      yingdao as never,
      {} as never
    )
    service["dispatchTask"] = jest.fn()
    return { service, prisma, yingdao }
  }

  it.each([
    ["OMNI_1_1_FLASH", 4, "360p"],
    ["OMNI_1_1_FLASH", 6, "720p"],
    ["OMNI_1_1_FLASH", 8, "360p"],
    ["OMNI_1_1_FLASH", 10, "720p"],
    ["VEO_3_1_LITE", 8, "720p"],
    ["VEO_3_1_FAST", 8, "720p"],
    ["VEO_3_1_QUALITY", 8, "720p"],
  ])("%s 支持 %i 秒 %s，选择落库并返回", async (model, durationSec, resolution) => {
    const { service, prisma } = setup()
    const result = await service.createTask(
      3,
      { ...video, model, durationSec, resolution },
      7,
      "request"
    )
    expect((prisma.rpaCreationTask.create.mock.calls[0] as unknown[])[0]).toMatchObject({
      data: { model, durationSec, resolution },
    })
    expect(result).toMatchObject({ model, durationSec, resolution })
    const option = service.getCapabilities().VIDEO.models.find(item => item.value === model)!
    expect(option.durations).toContain(durationSec)
    expect(option.resolutions).toContain(resolution)
  })

  it.each([
    { model: "OMNI_1_1_FLASH", durationSec: 15 },
    { model: "OMNI_1_1_FLASH", durationSec: 4.5 },
    { model: "OMNI_1_1_FLASH", durationSec: undefined },
    { model: "OMNI_1_1_FLASH", durationSec: null },
    { model: "OMNI_1_1_FLASH", resolution: "1080p" },
    { model: "VEO_3_1_LITE", durationSec: 4 },
    { model: "VEO_3_1_FAST", durationSec: 6 },
    { model: "VEO_3_1_QUALITY", durationSec: 10 },
    { model: "VEO_3_1_LITE", resolution: "360p" },
    { model: "VEO_3_1_FAST", resolution: "360p" },
    { model: "VEO_3_1_QUALITY", resolution: "360p" },
  ])("非法组合 %j 在建任务前拒绝", async overrides => {
    const { service, prisma, yingdao } = setup()
    const dto = plainToInstance(CreateRpaCreationTaskDto, { ...video, ...overrides })
    await expect(service.createTask(3, dto, 7, "request")).rejects.toBeInstanceOf(
      BadRequestException
    )
    expect(prisma.rpaCreationTask.create).not.toHaveBeenCalled()
    expect(yingdao.uploadFile).not.toHaveBeenCalled()
  })

  it("DTO whitelist 保留 resolution，省略时服务默认 720p", async () => {
    const { service } = setup()
    const dto = plainToInstance(CreateRpaCreationTaskDto, { ...video, resolution: "360p" })
    expect(await validate(dto, { whitelist: true })).toEqual([])
    expect(dto.resolution).toBe("360p")
    expect(await service.createTask(3, video, 7, "request")).toMatchObject({ resolution: "720p" })
  })

  it("图片拒绝分辨率参数，正常图片下发不携带视频字段", async () => {
    const { service } = setup()
    const dto: CreateRpaCreationTaskDto = {
      mediaType: "IMAGE",
      model: "NANO_BANANA_2",
      prompt: "测试图片",
      aspectRatio: "4:3",
      quantity: 1,
    }
    await expect(
      service.createTask(3, { ...dto, resolution: "720p" }, 7, "invalid")
    ).rejects.toThrow("图片生成不能传视频模式、时长或分辨率")
    const result = await service.createTask(3, dto, 7, "valid")
    const payload = service["buildRpaPayload"](result as RpaCreationTask)
    expect(result.resolution).toBeNull()
    expect(payload).not.toHaveProperty("resolution")
    expect(payload).not.toHaveProperty("duration")
  })

  it("首次派发及失败重试从持久化任务读取同一分辨率", async () => {
    const { service, prisma, yingdao } = setup()
    const created = await service.createTask(
      3,
      { ...video, durationSec: 10, resolution: "360p" },
      7,
      "request"
    )
    const stored = { ...created, yingdaoTaskUuid: null } as RpaCreationTask
    prisma.rpaCreationTask.findUnique.mockResolvedValue(stored)
    await service["runDispatch"](stored.id)
    await service["runRetry"](stored, 1)
    const payloads = yingdao.uploadFile.mock.calls.map(
      ([content]: [Buffer]) => JSON.parse(content.toString()) as object[]
    )
    expect(payloads).toMatchObject([
      [
        {
          model: "Omni 1.1 Flash",
          modelCode: "OMNI_1_1_FLASH",
          resolution: "360p",
          duration: 10,
          quantity: 2,
        },
      ],
      [{ resolution: "360p", duration: 10, quantity: 1 }],
    ])
    expect((prisma.rpaCreationTask.updateMany.mock.calls[0] as unknown[])[0]).toMatchObject({
      data: {
        paramsSnapshot: { resolution: "360p" },
        progressMessage: "参数已准备，正在提交生成任务",
      },
    })
    expect((prisma.rpaCreationTask.updateMany.mock.calls[1] as unknown[])[0]).toMatchObject({
      data: { progressMessage: "已提交，排队生成中" },
    })
  })

  it("旧任务空分辨率回落 720p，历史非法时长在上传前拒绝", async () => {
    const { service, yingdao } = setup()
    const task = {
      ...video,
      resolution: null,
      requestId: "old",
      referenceImageUrls: [],
      referenceVideoUrls: [],
    } as unknown as RpaCreationTask
    expect(service["buildRpaPayload"](task).resolution).toBe("720p")
    await expect(
      service["runRetry"]({ ...task, model: "VEO_3_1_FAST", durationSec: 15 }, 1)
    ).rejects.toThrow("Veo 3.1 - Fast 视频时长仅支持 8 秒")
    expect(yingdao.uploadFile).not.toHaveBeenCalled()
  })

  it("参考素材读取失败返回中性提示，上游细节只保留在日志", async () => {
    const { service, prisma } = setup()
    const spaces = {
      getPublicObjectMetadata: jest.fn().mockRejectedValue(new Error("读取 rpa-inputs 失败")),
    }
    Object.assign(service, { spaces })
    const errorLog = jest.spyOn(service["logger"], "error").mockImplementation(() => {})

    await expect(
      service.createTask(
        3,
        { ...video, referenceImageUrls: ["https://cdn.example.com/input.png"] },
        7,
        "request"
      )
    ).rejects.toThrow("参考素材尚未上传完成或无法读取，请重新上传")
    expect(prisma.rpaCreationTask.create).not.toHaveBeenCalled()
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("读取 rpa-inputs 失败"))
  })
})

describe("RpaCreationService.removeResults", () => {
  function setup(outputs: OutputRow[]) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 10 }]),
      rpaCreationOutput: {
        findMany: jest.fn().mockResolvedValue(outputs),
        updateMany: jest.fn().mockResolvedValue({ count: outputs.length }),
      },
      rpaCreationTask: {
        findMany: jest.fn().mockResolvedValue([{ id: 10 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      rpaCreationProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const service = new RpaCreationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )
    return { service, tx }
  }

  it("批量软删除图片和视频输出并清理空父任务", async () => {
    const { service, tx } = setup([
      { id: 1, taskId: 10, status: "SUCCESS", task: { mediaType: "IMAGE", status: "SUCCESS" } },
      { id: 2, taskId: 11, status: "FAILED", task: { mediaType: "VIDEO", status: "SUCCESS" } },
    ])

    await expect(service.removeResults(3, [1, 2], 7)).resolves.toEqual({
      success: true,
      requestedCount: 2,
      removedCount: 2,
      removedImages: 1,
      removedVideos: 1,
      removedEmptyTasks: 1,
    })
    expect(tx.rpaCreationOutput.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.rpaCreationTask.updateMany).toHaveBeenCalledTimes(1)
  })

  it("混入无效 ID 时整批拒绝", async () => {
    const { service, tx } = setup([
      { id: 1, taskId: 10, status: "SUCCESS", task: { mediaType: "IMAGE", status: "SUCCESS" } },
    ])

    await expect(service.removeResults(3, [1, 2], 7)).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.rpaCreationOutput.updateMany).not.toHaveBeenCalled()
  })

  it("包含等待中或生成中结果时整批拒绝", async () => {
    const { service, tx } = setup([
      { id: 1, taskId: 10, status: "GENERATING", task: { mediaType: "IMAGE", status: "PENDING" } },
    ])

    await expect(service.removeResults(3, [1], 7)).rejects.toThrow("等待中或生成中的结果不可移除")
    expect(tx.rpaCreationOutput.updateMany).not.toHaveBeenCalled()
  })
})

describe("RpaCreationService.completeTask 扣费", () => {
  const baseTask = {
    id: 10,
    requestId: "request-10",
    clientRequestId: "client-10",
    projectId: 3,
    userId: 7,
    mediaType: "VIDEO",
    inputMode: "INGREDIENTS",
    prompt: "测试",
    model: "VEO_3_1_FAST",
    aspectRatio: "16:9",
    quantity: 1,
    durationSec: 10,
    referenceImageUrls: [],
    referenceVideoUrls: [],
    paramsSnapshot: null,
    paramsFileKey: null,
    yingdaoTaskUuid: "yingdao-10",
    yingdaoJobUuidList: [],
    status: "PENDING",
    progressMessage: null,
    errorMessage: null,
    startedAt: new Date(),
    completedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }

  function setup(task = baseTask, outputStatus = "PENDING") {
    const output = {
      id: 101,
      taskId: task.id,
      order: 0,
      status: outputStatus,
      url: outputStatus === "SUCCESS" ? "https://cdn.example.com/result.mp4" : null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    }
    const completed = {
      ...task,
      status: "SUCCESS",
      completedAt: new Date(),
      outputs: [{ ...output, status: "SUCCESS", url: "https://cdn.example.com/result.mp4" }],
    }
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: task.id }]),
      rpaCreationOutput: {
        findMany: jest.fn().mockResolvedValue([output]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      rpaCreationTask: {
        findUnique: jest.fn().mockResolvedValue(task),
        findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        update: jest.fn().mockResolvedValue(completed),
      },
    }
    const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      rpaCreationOutput: { findMany: jest.fn().mockResolvedValue([output]) },
      rpaCreationTask: {
        findUnique: jest.fn().mockResolvedValue(task),
        findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const config = { get: jest.fn().mockReturnValue("callback-token") }
    const usage = { chargeExactCreditsInTransaction: jest.fn().mockResolvedValue({}) }
    const service = new RpaCreationService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
      usage as never
    )
    ;(
      service as unknown as {
        validateReportedOutputs: jest.Mock
      }
    ).validateReportedOutputs = jest
      .fn()
      .mockResolvedValue([{ success: true, url: "https://cdn.example.com/result.mp4" }])
    return { service, prisma, tx, usage }
  }

  it("10 秒视频成功回调扣 9.6 积分，扣费与状态更新共用事务", async () => {
    const { service, tx, usage } = setup()

    await service.completeTask("request-10", "Bearer callback-token", {
      outputs: [{ status: "SUCCESS", url: "https://source.example.com/result.mp4" }],
    })

    expect(usage.chargeExactCreditsInTransaction).toHaveBeenCalledTimes(1)
    const call = usage.chargeExactCreditsInTransaction.mock.calls[0] as [
      typeof tx,
      number,
      { credits: Decimal; costCny: Decimal; source: string; meta: Record<string, unknown> },
    ]
    expect(call[0]).toBe(tx)
    expect(call[1]).toBe(7)
    expect(call[2].credits.toString()).toBe("9.6")
    expect(call[2].costCny.toString()).toBe("0.96")
    expect(call[2].source).toBe("rpa-creation.generate")
    expect(call[2].meta).toMatchObject({ successfulOutputIds: [101], googleFlowCredits: "15" })
  })

  it("图片每个成功输出固定扣 1 积分", () => {
    const { service } = setup()
    const quote = (
      service as unknown as {
        quoteSuccessfulOutputs: (
          task: object,
          count: number
        ) => { platformCredits: Decimal; platformPriceCny: Decimal }
      }
    ).quoteSuccessfulOutputs({ ...baseTask, mediaType: "IMAGE", durationSec: null }, 2)

    expect(quote.platformCredits.toString()).toBe("2")
    expect(quote.platformPriceCny.toString()).toBe("0.2")
  })

  it.each([
    [4, "3.84"],
    [6, "5.76"],
    [8, "7.68"],
    [10, "9.6"],
    [15, "14.4"],
  ])("%i 秒视频每个成功输出扣 %s 积分", (durationSec, expectedCredits) => {
    const { service } = setup()
    const quote = (
      service as unknown as {
        quoteSuccessfulOutputs: (
          task: object,
          count: number
        ) => { platformCredits: Decimal; platformPriceCny: Decimal }
      }
    ).quoteSuccessfulOutputs({ ...baseTask, durationSec }, 1)

    expect(quote.platformCredits.toString()).toBe(expectedCredits)
  })

  it("任务提交拒绝 Veo 的 15 秒请求", () => {
    const { service } = setup()
    const validateTask = (
      service as unknown as {
        validateTask: (dto: object) => {
          referenceImageUrls: string[]
          referenceVideoUrls: string[]
        }
      }
    ).validateTask.bind(service)

    expect(() =>
      validateTask({
        mediaType: "VIDEO",
        inputMode: "INGREDIENTS",
        prompt: "测试",
        model: "VEO_3_1_FAST",
        aspectRatio: "16:9",
        quantity: 1,
        durationSec: 15,
        referenceImageUrls: [],
        referenceVideoUrls: [],
      })
    ).toThrow("Veo 3.1 - Fast 视频时长仅支持 8 秒")
  })

  it("失败输出不扣积分", async () => {
    const { service, usage } = setup()

    await service.completeTask("request-10", "Bearer callback-token", {
      outputs: [{ status: "FAILED", errorMessage: "生成失败" }],
    })

    expect(usage.chargeExactCreditsInTransaction).not.toHaveBeenCalled()
  })

  it.each([
    { status: "FAILED" as const, errorMessage: "GoogleFlow / 影刀 RPA 执行失败" },
    { status: "SUCCESS" as const },
    { status: "SUCCESS" as const, url: "https://source.example.com/result.mp4" },
  ])("回调失败不透传上游原因：%j", async output => {
    const { service, tx, usage } = setup()
    service["validateReportedOutputs"] =
      RpaCreationService.prototype["validateReportedOutputs"].bind(service)
    service["transferResult"] = jest.fn().mockRejectedValue(new Error("Flow 下载失败"))
    const log = jest.spyOn(service["logger"], "log").mockImplementation(() => {})
    const errorLog = jest.spyOn(service["logger"], "error").mockImplementation(() => {})

    await service.completeTask("request-10", "Bearer callback-token", { outputs: [output] })

    expect(tx.rpaCreationOutput.update).toHaveBeenCalledWith({
      where: { id: 101, deletedAt: null },
      data: { status: "FAILED", url: null, errorMessage: "生成失败，请重试" },
    })
    expect(usage.chargeExactCreditsInTransaction).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(output)))
    if ("url" in output) {
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Flow 下载失败"))
    }
  })

  it("历史任务列表、详情、重复创建隐藏供应商名称，同时保留模型展示名和产物尺寸", async () => {
    const { service, prisma } = setup()
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      { publicId: baseTask.model, displayName: "目录模型名称" },
    ])
    const stored = {
      ...baseTask,
      resolution: "720p",
      status: "TIMEOUT",
      progressMessage: "已提交影刀 RPA 队列",
      errorMessage: "RPA 任务超过 1 小时未完成",
      outputs: [
        { id: 101, errorMessage: "Google Flow 执行失败", deliveryMeta: { width: 1280, height: 720 } },
        { id: 102, errorMessage: "FLOW 执行失败" },
        { id: 103, errorMessage: "生成超时，请重试" },
        { id: 104, errorMessage: null },
      ],
    }
    const taskDb = {
      ...prisma.rpaCreationTask,
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([stored]),
      findFirst: jest.fn().mockResolvedValue(stored),
      findUnique: jest.fn().mockResolvedValue(stored),
    }
    Object.assign(prisma, {
      rpaCreationTask: taskDb,
      rpaCreationProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
    })
    const { items } = await service.findAllTasks({ page: 1, pageSize: 10 }, 7)
    const detail = await service.findOneTask(10, 7)
    const duplicate = await service.createTask(3, {} as CreateRpaCreationTaskDto, 7, "client-10")

    for (const result of [items[0], detail, duplicate]) {
      expect(result).toMatchObject({
        displayName: "目录模型名称",
        resolution: "720p",
        requestedDurationSec: 10,
        requestedResolution: "720p",
        progressMessage: "已提交，排队生成中",
        errorMessage: "生成超时，请重试",
        outputs: [
          { id: 101, errorMessage: "生成失败，请重试", width: 1280, height: 720 },
          { id: 102, errorMessage: "生成失败，请重试" },
          { id: 103, errorMessage: "生成超时，请重试" },
          { id: 104, errorMessage: null },
        ],
      })
      expect(result).not.toHaveProperty("yingdaoTaskUuid")
    }
    expect(stored.outputs[0].errorMessage).toBe("Google Flow 执行失败")
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("首次提交失败只保存中性提示，日志保留上游原因", async () => {
    const { service, prisma, tx } = setup({
      ...baseTask,
      model: "OMNI_1_1_FLASH",
      yingdaoTaskUuid: "",
    })
    const provider = { uploadFile: jest.fn().mockRejectedValue(new Error("影刀 RPA 上传失败")) }
    Object.assign(service, { yingdao: provider })
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    Object.assign(tx.rpaCreationTask, { updateMany })
    const errorLog = jest.spyOn(service["logger"], "error").mockImplementation(() => {})

    await expect(service["runDispatch"](10)).rejects.toThrow("影刀 RPA 上传失败")

    expect(updateMany.mock.calls[0]).toMatchObject([
      { data: { errorMessage: "提交失败，请稍后重试" } },
    ])
    expect(tx.rpaCreationOutput.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED", errorMessage: "提交失败，请稍后重试" } })
    )
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("影刀 RPA 上传失败"))
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it("重试提交失败返回 503 中性提示并恢复失败席位", async () => {
    const { service, tx } = setup({ ...baseTask, status: "SUCCESS" }, "FAILED")
    tx.rpaCreationTask.findUnique.mockResolvedValue({
      ...baseTask,
      status: "SUCCESS",
      durationSec: 8,
      outputs: [{ id: 101, status: "FAILED" }],
    })
    tx.rpaCreationOutput.updateMany.mockResolvedValue({ count: 1 })
    service["runRetry"] = jest.fn().mockRejectedValue(new Error("影刀 GoogleFlow 提交失败"))
    const errorLog = jest.spyOn(service["logger"], "error").mockImplementation(() => {})

    const error = await service.retryTask(10, 7).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ServiceUnavailableException)
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      message: "提交失败，请稍后重试",
    })
    expect(tx.rpaCreationOutput.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: "FAILED", errorMessage: "提交失败，请稍后重试" } })
    )
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("影刀 GoogleFlow 提交失败"))
  })

  it("已成功任务的重复回调直接返回，不重复扣费", async () => {
    const successfulTask = { ...baseTask, status: "SUCCESS", completedAt: new Date() }
    const { service, prisma, usage } = setup(successfulTask, "SUCCESS")

    await service.completeTask("request-10", "Bearer callback-token", {
      outputs: [{ status: "SUCCESS", url: "https://source.example.com/result.mp4" }],
    })

    expect(usage.chargeExactCreditsInTransaction).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
