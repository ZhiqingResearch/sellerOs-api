import { ConfigService } from "@nestjs/config"
import { ProductPublishFeishuSyncTrigger } from "@prisma/client"
import { ProductPublishStoreSyncService } from "./product-publish-store-sync.service"
import { ProductPublishStoreSyncTask } from "./product-publish-store-sync.task"

describe("ProductPublishStoreSyncTask", () => {
  let syncService: { syncFromFeishu: jest.Mock }
  let config: { get: jest.Mock }
  let task: ProductPublishStoreSyncTask

  beforeEach(() => {
    syncService = {
      syncFromFeishu: jest.fn().mockResolvedValue({
        configured: true,
        total: 1,
        created: 1,
        updated: 0,
        failed: 0,
        skipped: 0,
      }),
    }
    config = { get: jest.fn().mockReturnValue("prod") }
    task = new ProductPublishStoreSyncTask(
      syncService as unknown as ProductPublishStoreSyncService,
      config as unknown as ConfigService
    )
  })

  it("每日任务触发飞书店铺同步", async () => {
    await task.handleDailySync()
    expect(syncService.syncFromFeishu).toHaveBeenCalledWith(
      ProductPublishFeishuSyncTrigger.SCHEDULED
    )
  })

  it("同步失败时仅记录错误，不让 Cron 抛出", async () => {
    syncService.syncFromFeishu.mockRejectedValue(new Error("飞书超时"))
    await expect(task.handleDailySync()).resolves.toBeUndefined()
  })

  it.each(["dev", "dev1", "uat", ""])("profile=%s 时跳过飞书同步", async profile => {
    config.get.mockReturnValue(profile)

    await task.handleDailySync()

    expect(syncService.syncFromFeishu).not.toHaveBeenCalled()
  })
})
