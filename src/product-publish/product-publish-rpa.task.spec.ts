import { ConfigService } from "@nestjs/config"
import { ProductPublishRpaService } from "./product-publish-rpa.service"
import { ProductPublishRpaTask } from "./product-publish-rpa.task"

describe("ProductPublishRpaTask", () => {
  let rpaService: {
    refreshTemplates: jest.Mock
    pollPublishingTasks: jest.Mock
  }
  let config: { get: jest.Mock }
  let task: ProductPublishRpaTask

  beforeEach(() => {
    rpaService = {
      refreshTemplates: jest.fn().mockResolvedValue(undefined),
      pollPublishingTasks: jest.fn().mockResolvedValue(undefined),
    }
    config = { get: jest.fn().mockReturnValue("prod") }
    task = new ProductPublishRpaTask(
      rpaService as unknown as ProductPublishRpaService,
      config as unknown as ConfigService
    )
  })

  it("每日任务触发一键上架模板刷新", async () => {
    await task.handleDailyTemplateRefresh()

    expect(rpaService.refreshTemplates).toHaveBeenCalledTimes(1)
  })

  it("模板刷新失败时仅记录错误，不让 Cron 抛出", async () => {
    rpaService.refreshTemplates.mockRejectedValue(new Error("影刀请求超时"))

    await expect(task.handleDailyTemplateRefresh()).resolves.toBeUndefined()
  })

  it.each(["dev", "dev1", "uat", ""])("profile=%s 时跳过模板刷新", async profile => {
    config.get.mockReturnValue(profile)

    await task.handleDailyTemplateRefresh()

    expect(rpaService.refreshTemplates).not.toHaveBeenCalled()
  })

  it("每五分钟触发上架中任务结果查询", async () => {
    config.get.mockReturnValue("dev")
    await task.handlePublishingTaskPoll()

    expect(rpaService.pollPublishingTasks).toHaveBeenCalledTimes(1)
  })

  it("结果查询失败时仅记录错误，不让 Cron 抛出", async () => {
    rpaService.pollPublishingTasks.mockRejectedValue(new Error("影刀请求失败"))

    await expect(task.handlePublishingTaskPoll()).resolves.toBeUndefined()
  })
})
