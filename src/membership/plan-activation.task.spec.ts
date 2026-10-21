import { CreditService } from "./credit.service"
import { PlanActivationTask } from "./plan-activation.task"

describe("PlanActivationTask", () => {
  let credit: { activateAllDuePlans: jest.Mock }
  let task: PlanActivationTask

  beforeEach(() => {
    credit = { activateAllDuePlans: jest.fn().mockResolvedValue({ activated: 2, users: 1 }) }
    task = new PlanActivationTask(credit as unknown as CreditService)
  })

  it("每日任务调用 activateAllDuePlans", async () => {
    await task.handleDailyActivate()
    expect(credit.activateAllDuePlans).toHaveBeenCalledTimes(1)
  })

  it("启动时 catch-up 调用 activateAllDuePlans", () => {
    task.onModuleInit()
    expect(credit.activateAllDuePlans).toHaveBeenCalledTimes(1)
  })

  it("activateAllDuePlans 抛错不向上抛（仅记日志）", async () => {
    credit.activateAllDuePlans.mockRejectedValue(new Error("boom"))
    await expect(task.handleDailyActivate()).resolves.toBeUndefined()
  })
})
