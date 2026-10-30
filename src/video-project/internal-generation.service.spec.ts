import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import type { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import type { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import type { PrismaService } from "../prisma/prisma.service"
import type { UsageService } from "../usage/usage.service"
import { InternalGenerationService } from "./internal-generation.service"

function createHarness() {
  const prisma = {
    user: { findUnique: jest.fn() },
    aiGatewayModel: { findFirst: jest.fn() },
    videoProject: { findFirst: jest.fn(), create: jest.fn() },
    videoTask: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    usageLog: { findUnique: jest.fn() },
  }
  const gateway = {
    estimateVideoPrice: jest.fn().mockResolvedValue({ variants: [] }),
    maximumQuoteAmount: jest.fn().mockReturnValue({ mul: jest.fn().mockReturnThis() }),
    createVideoTask: jest.fn(),
    cancelVideoTask: jest.fn(),
  }
  const gatewayWebhook = { applyVideoTask: jest.fn(), reconcileVideoTaskOnRead: jest.fn() }
  const usage = {
    assertGatewayAffordable: jest.fn(),
    assertExactCreditsAffordable: jest.fn(),
    resolveFixedVideoTier: jest.fn().mockResolvedValue(null),
  }
  const service = new InternalGenerationService(
    prisma as unknown as PrismaService,
    gateway as unknown as AiGatewayProvider,
    gatewayWebhook as unknown as AiGatewayWebhookService,
    usage as unknown as UsageService, { refresh: jest.fn() } as never
  )
  return { service, prisma, gateway, gatewayWebhook, usage }
}

describe("InternalGenerationService", () => {
  it.each(["NORMAL", "REFERENCE", "MOTION_CONTROL", "BEAUTY"])(
    "%s 按模型与业务分类命中目录和固定价预检，不跨类别取价",
    async category => {
      const { service, prisma, gateway, usage } = createHarness()
      prisma.user.findUnique.mockResolvedValue({ id: 7 })
      prisma.aiGatewayModel.findFirst.mockImplementation(
        ({ where }: { where: { publicId: string; category: string } }) =>
          Promise.resolve(
            where.publicId === "shared-model" && where.category === category
              ? { publicId: "shared-model", category, priceMultiplier: 9 }
              : { publicId: "shared-model", category: "WRONG_CATEGORY", priceMultiplier: 1 }
          )
      )
      prisma.videoProject.findFirst.mockResolvedValue({ id: 501 })
      prisma.videoTask.create.mockResolvedValue({ id: 900 })
      prisma.videoTask.findUnique.mockResolvedValue({ status: "GENERATING" })
      gateway.createVideoTask.mockResolvedValue({ id: "gw_900", status: "queued" })
      usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(2), flat: false })

      await service.createVideoTask({
        phone: "13800000001",
        category,
        request: {
          model: "shared-model",
          prompt: "x",
          mode: "reference_to_video",
          resolution: "480p",
          duration_seconds: 5,
        },
      })

      expect(prisma.aiGatewayModel.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            publicId: "shared-model",
            category,
            enabled: true,
            gatewayActive: true,
          }) as unknown,
        })
      )
      expect(prisma.videoTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mode: category, model: "shared-model" }) as unknown,
        })
      )
      expect(usage.resolveFixedVideoTier).toHaveBeenCalledWith(
        "shared-model",
        category,
        "480p",
        "reference_to_video"
      )
      expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal(10))
      expect(usage.assertGatewayAffordable).not.toHaveBeenCalled()
      expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
      expect((gateway.createVideoTask.mock.calls as unknown[][])[0][0]).not.toHaveProperty(
        "category"
      )
    }
  )

  it("拒绝省略类别的旧调用，不能任取模型目录行", async () => {
    const { service, prisma, gateway } = createHarness()
    await expect(
      service.createVideoTask({
        phone: "13800000001",
        request: { model: "m", prompt: "x" },
      } as Parameters<InternalGenerationService["createVideoTask"]>[0])
    ).rejects.toThrow("必须指定视频模型业务分类")
    expect(prisma.aiGatewayModel.findFirst).not.toHaveBeenCalled()
    expect(gateway.createVideoTask).not.toHaveBeenCalled()
  })

  it("该类别没有启用模型时拒绝提交，不回落其他类别", async () => {
    const { service, prisma, gateway } = createHarness()
    prisma.user.findUnique.mockResolvedValue({ id: 7 })
    prisma.aiGatewayModel.findFirst.mockResolvedValue(null)
    await expect(
      service.createVideoTask({
        phone: "13800000001",
        category: "REFERENCE",
        request: { model: "m", prompt: "x" },
      })
    ).rejects.toThrow("模型不存在或未启用")
    expect(prisma.videoTask.create).not.toHaveBeenCalled()
    expect(gateway.createVideoTask).not.toHaveBeenCalled()
  })

  it("固定价余额不足时不创建任务、不请求网关生成", async () => {
    const { service, prisma, gateway, usage } = createHarness()
    prisma.user.findUnique.mockResolvedValue({ id: 7 })
    prisma.aiGatewayModel.findFirst.mockResolvedValue({
      publicId: "m",
      category: "BEAUTY",
      priceMultiplier: 1,
    })
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(2), flat: true })
    usage.assertExactCreditsAffordable.mockRejectedValue(new BadRequestException("积分不足"))
    await expect(
      service.createVideoTask({
        phone: "13800000001",
        category: "BEAUTY",
        request: { model: "m", prompt: "x", duration_seconds: 5 },
      })
    ).rejects.toThrow("积分不足")
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal(2))
    expect(prisma.videoTask.create).not.toHaveBeenCalled()
    expect(gateway.createVideoTask).not.toHaveBeenCalled()
  })

  it("手机号无对应用户抛 404 USER_NOT_FOUND", async () => {
    const { service, prisma } = createHarness()
    prisma.user.findUnique.mockResolvedValue(null)

    await expect(
      service.createVideoTask({
        phone: "13800000000",
        category: "NORMAL",
        request: { model: "m", prompt: "x" },
      })
    ).rejects.toThrow(NotFoundException)
  })

  it("提交链路：容器项目 + source=vidflowos + vidflowos 专属 Key 提交网关", async () => {
    const { service, prisma, gateway } = createHarness()
    prisma.user.findUnique.mockResolvedValue({ id: 7 })
    prisma.aiGatewayModel.findFirst.mockResolvedValue({
      publicId: "sourcing-veo-fast-i2v",
      category: "NORMAL",
      priceMultiplier: 2,
    })
    prisma.videoProject.findFirst.mockResolvedValue(null)
    prisma.videoProject.create.mockResolvedValue({ id: 501 })
    prisma.videoTask.create.mockResolvedValue({ id: 900 })
    gateway.createVideoTask.mockResolvedValue({ id: "gw_900", status: "queued", usage: null })
    prisma.videoTask.update.mockResolvedValue({ id: 900 })
    prisma.videoTask.findUnique.mockResolvedValue({ status: "GENERATING" })

    const result = await service.createVideoTask({
      phone: "13800000001",
      category: "NORMAL",
      request: { model: "sourcing-veo-fast-i2v", prompt: "海边日出" },
    })

    expect(result).toEqual({ taskId: 900, status: "GENERATING" })
    // 容器项目：source=vidflowos
    expect(prisma.videoProject.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "vidflowos", userId: 7 }) as unknown,
      })
    )
    // 任务行：source=vidflowos、挂容器项目、mode 取模型 category
    expect(prisma.videoTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "vidflowos",
          projectId: 501,
          mode: "NORMAL",
        }) as unknown,
      })
    )
    // 网关提交：vidflowos 专属 Key + 预检
    expect(gateway.createVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: "sourcing-veo-fast-i2v", callback: true }),
      "video-task:900",
      "vidflowos"
    )
  })

  it("网关明确拒绝（400）时任务终态 FAILED 并抛出", async () => {
    const { service, prisma, gateway } = createHarness()
    prisma.user.findUnique.mockResolvedValue({ id: 7 })
    prisma.aiGatewayModel.findFirst.mockResolvedValue({
      publicId: "m",
      category: "NORMAL",
      priceMultiplier: 1,
    })
    prisma.videoProject.findFirst.mockResolvedValue({ id: 501 })
    prisma.videoTask.create.mockResolvedValue({ id: 901 })
    gateway.createVideoTask.mockRejectedValue(new BadRequestException("参数不合法"))
    prisma.videoTask.findUnique.mockResolvedValue({ status: "FAILED" })

    await expect(
      service.createVideoTask({
        phone: "13800000001",
        category: "NORMAL",
        request: { model: "m", prompt: "x" },
      })
    ).rejects.toThrow(BadRequestException)
    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: { id: 901, status: { in: ["GENERATING", "WAITING_MODERATION"] }, deletedAt: null },
      data: { status: "FAILED", errorMessage: "AI Gateway 视频任务提交失败" },
    })
  })

  it("查询：扣费留痕取自 UsageLog（requestId=gateway:{gatewayTaskId}）", async () => {
    const { service, prisma } = createHarness()
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 900,
      status: "SUCCESS",
      gatewayTaskId: "gw_900",
      resultUrl: "https://cdn.example.com/v.mp4",
      errorMessage: null,
      durationSec: 6,
      resolution: "720p",
    })
    prisma.usageLog.findUnique.mockResolvedValue({ cost: "0.75", credits: "15" })

    const result = await service.getVideoTask(900)

    expect(prisma.usageLog.findUnique).toHaveBeenCalledWith({
      where: { requestId: "gateway:gw_900" },
      select: { cost: true, credits: true },
    })
    expect(result).toMatchObject({
      status: "SUCCESS",
      resultUrl: "https://cdn.example.com/v.mp4",
      costCny: "0.75",
      creditsCharged: "15",
    })
  })

  it("查询非 vidflowos 来源任务抛 404（隔离）", async () => {
    const { service, prisma } = createHarness()
    prisma.videoTask.findFirst.mockResolvedValue(null)
    await expect(service.getVideoTask(1)).rejects.toThrow(NotFoundException)
  })

  it("取消：仅 GENERATING 可取消，用 vidflowos Key 调网关", async () => {
    const { service, prisma, gateway, gatewayWebhook } = createHarness()
    prisma.videoTask.findFirst
      .mockResolvedValueOnce({ status: "GENERATING", gatewayTaskId: "gw_900" })
      .mockResolvedValueOnce({ status: "CANCELLED" })
    gateway.cancelVideoTask.mockResolvedValue({ id: "gw_900", status: "canceled", usage: null })

    const result = await service.cancelVideoTask(900)

    expect(result).toEqual({ status: "CANCELLED" })
    expect(gateway.cancelVideoTask).toHaveBeenCalledWith("gw_900", "vidflowos")
    expect(gatewayWebhook.applyVideoTask).toHaveBeenCalled()
  })
})
