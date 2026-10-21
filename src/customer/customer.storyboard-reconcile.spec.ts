import { ForbiddenException } from "@nestjs/common"
import { CustomerService } from "./customer.service"

describe("CustomerService.findStoryboardsByIds 分镜视频读时对账", () => {
  function setup() {
    const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      storyboard: {
        findUnique: jest.fn().mockResolvedValue({
          production: { project: { customer: { userId: 7 } } },
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      storyboardVideo: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    }
    const gatewayWebhook = { reconcileStoryboardVideoOnRead: jest.fn().mockResolvedValue(false) }
    const service = new CustomerService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gatewayWebhook as never,
      {} as never
    )
    return { service, prisma, gatewayWebhook }
  }

  const generatingVideo = { id: 20, status: "GENERATING", gatewayTaskId: "task_story" }

  it("轮询时对 GENERATING 席位视频顺带查网关，权威行不进墙钟超时", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.storyboardVideo.findMany.mockResolvedValue([generatingVideo])
    gatewayWebhook.reconcileStoryboardVideoOnRead.mockResolvedValue(true)

    await service.findStoryboardsByIds([1], 7)

    expect(gatewayWebhook.reconcileStoryboardVideoOnRead).toHaveBeenCalledWith(generatingVideo)
    expect(prisma.storyboardVideo.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: [20] } }),
        data: { status: "TIMEOUT", errorMessage: "视频生成超时" },
      })
    )
  })

  it("网关确认仍在跑且没有其它超时行时墙钟扫地不落任何更新条件外的行", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.storyboardVideo.findMany.mockResolvedValue([generatingVideo])
    gatewayWebhook.reconcileStoryboardVideoOnRead.mockResolvedValue(true)

    await service.findStoryboardsByIds([1], 7)

    const where = prisma.storyboardVideo.updateMany.mock.calls[0][0].where
    expect(where.status).toBe("GENERATING")
    expect(where.id).toEqual({ notIn: [20] })
  })

  it("对账拿不到权威结论时维持原有墙钟超时行为", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.storyboardVideo.findMany.mockResolvedValue([generatingVideo])
    gatewayWebhook.reconcileStoryboardVideoOnRead.mockResolvedValue(false)

    await service.findStoryboardsByIds([1], 7)

    const where = prisma.storyboardVideo.updateMany.mock.calls[0][0].where
    expect(where.id).toBeUndefined()
  })

  it("非本人分镜头拒绝访问", async () => {
    const { service, prisma } = setup()
    prisma.storyboard.findUnique.mockResolvedValue({
      production: { project: { customer: { userId: 8 } } },
    })

    await expect(service.findStoryboardsByIds([1], 7)).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.storyboardVideo.findMany).not.toHaveBeenCalled()
  })
})
