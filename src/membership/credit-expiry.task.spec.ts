import { CreditExpiryTask } from "./credit-expiry.task"
import { CreditService } from "./credit.service"

describe("CreditExpiryTask", () => {
  let credit: { expireLots: jest.Mock }
  let task: CreditExpiryTask

  beforeEach(() => {
    credit = { expireLots: jest.fn().mockResolvedValue({ expired: 3 }) }
    task = new CreditExpiryTask(credit as unknown as CreditService)
  })

  it("每日任务调用 expireLots", async () => {
    await task.handleDailyExpire()
    expect(credit.expireLots).toHaveBeenCalledTimes(1)
  })

  it("启动时 catch-up 调用 expireLots", () => {
    task.onModuleInit()
    expect(credit.expireLots).toHaveBeenCalledTimes(1)
  })

  it("expireLots 抛错不向上抛（仅记日志）", async () => {
    credit.expireLots.mockRejectedValue(new Error("boom"))
    await expect(task.handleDailyExpire()).resolves.toBeUndefined()
  })
})
