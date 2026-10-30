import { ForbiddenException } from "@nestjs/common"
import { SalesService } from "./sales.service"

describe("SalesService getWorkflow 读时对账", () => {
  function setup() {
    const wf = {
      id: 6,
      projectId: 26,
      userId: 7,
      segments: [],
      project: { id: 26, name: "带货项目", type: "ECOMMERCE" },
    }
    const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      salesWorkflow: { findUnique: jest.fn().mockResolvedValue(wf) },
      videoTask: { findMany: jest.fn() },
    }
    const gatewayWebhook = { reconcileVideoTaskOnRead: jest.fn().mockResolvedValue(false) }
    const service = new SalesService(prisma as never, {} as never, gatewayWebhook as never)
    return { service, prisma, wf, gatewayWebhook }
  }

  const baseTask = {
    id: 440,
    status: "GENERATING",
    gatewayTaskId: "task_g",
    prompt: "分镜提示词",
    resultUrl: null,
    thumbnailUrl: null,
    model: "sourcing-seedance-mini-reference",
    modelName: "Seedance 2.0 Mini 参考生视频",
    durationSec: 8,
    aspectRatio: "16:9",
    resolution: "720p",
    errorMessage: null,
    gatewayError: null,
    segmentOrder: 0,
    salesBatchNo: 2,
    createdAt: new Date("2026-09-01T10:00:00Z"),
  }

  it("对 GENERATING 行读时对账并重读任务，成片版本返回最新状态", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.videoTask.findMany
      .mockResolvedValueOnce([baseTask])
      .mockResolvedValueOnce([{ ...baseTask, status: "SUCCESS", resultUrl: "https://x/v.mp4" }])
    gatewayWebhook.reconcileVideoTaskOnRead.mockResolvedValue(true)

    const result = await service.getWorkflow(26, 7)

    expect(gatewayWebhook.reconcileVideoTaskOnRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: 440, gatewayTaskId: "task_g" })
    )
    expect(prisma.videoTask.findMany).toHaveBeenCalledTimes(2)
    expect(result.outputs[0].videos[0]).toMatchObject({
      status: "SUCCESS",
      resultUrl: "https://x/v.mp4",
    })
  })

  it("没有 GENERATING 行时不触发对账也不重读", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.videoTask.findMany.mockResolvedValue([{ ...baseTask, status: "SUCCESS" }])

    await service.getWorkflow(26, 7)

    expect(gatewayWebhook.reconcileVideoTaskOnRead).not.toHaveBeenCalled()
    expect(prisma.videoTask.findMany).toHaveBeenCalledTimes(1)
  })

  it("带货预览轮询推进没有网关ID的待审任务，并返回最新状态", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.videoTask.findMany.mockResolvedValueOnce([{ ...baseTask, status: "WAITING_MODERATION", gatewayTaskId: null }])
      .mockResolvedValueOnce([{ ...baseTask, status: "FAILED", gatewayTaskId: null }])
    const result = await service.getWorkflow(26, 7)
    expect(gatewayWebhook.reconcileVideoTaskOnRead).toHaveBeenCalledWith(expect.objectContaining({ status: "WAITING_MODERATION", gatewayTaskId: null }))
    expect(result.outputs[0].videos[0].status).toBe("FAILED")
  })

  it("非本人向导拒绝访问", async () => {
    const { service, prisma, wf } = setup()
    prisma.salesWorkflow.findUnique.mockResolvedValueOnce({ ...wf, userId: 8 })

    await expect(service.getWorkflow(26, 7)).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.videoTask.findMany).not.toHaveBeenCalled()
  })
})
