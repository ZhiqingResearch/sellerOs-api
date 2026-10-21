import { Test } from "@nestjs/testing"
import { MailProvider } from "../../common/providers/mail.provider"
import { PrismaService } from "../../prisma/prisma.service"
import { ExpiryReminderTask } from "./expiry-reminder.task"

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

/**
 * 到期提醒：个人/团队统一 T-7/3/1 三封临期提醒（产品定稿，到期当天不发）。
 * 窗口按**北京自然日**切（cron 与取日均钉 Asia/Shanghai，容器为 UTC 也不受影响）——
 * 本 spec 一律使用绝对时刻（Z 后缀）与绝对边界断言，保证在任意进程时区下结果一致。
 */
describe("ExpiryReminderTask", () => {
  const NOW = new Date("2026-08-19T17:30:00.000Z") // = 北京 2026-08-20 01:30（cron 触发后）
  let task: ExpiryReminderTask
  let prisma: {
    user: { findMany: jest.Mock }
    team: { findMany: jest.Mock }
  }
  let mail: { sendMail: jest.Mock }

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW.getTime())
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      team: { findMany: jest.fn().mockResolvedValue([]) },
    }
    mail = { sendMail: jest.fn().mockResolvedValue(undefined) }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpiryReminderTask,
        { provide: PrismaService, useValue: prisma },
        { provide: MailProvider, useValue: mail },
      ],
    }).compile()
    task = moduleRef.get(ExpiryReminderTask)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("个人：T-7/3/1 三个窗口各查一次（北京自然日 [N 天后, N+1 天后)）；到期当天/过期次日均不查", async () => {
    await task.run()

    expect(prisma.user.findMany).toHaveBeenCalledTimes(3)
    const windows = [0, 1, 2].map(
      i =>
        callArgs<[{ where: { subscriptionExpiresAt: { gte: Date; lt: Date } } }]>(
          prisma.user.findMany,
          i
        )[0].where.subscriptionExpiresAt
    )
    // 北京日界 = UTC 前一日 16:00：T-7 [8-27, 8-28)；T-3 [8-23, 8-24)；T-1 [8-21, 8-22)（均为北京日）
    expect(windows[0].gte.toISOString()).toBe("2026-08-26T16:00:00.000Z")
    expect(windows[0].lt.toISOString()).toBe("2026-08-27T16:00:00.000Z")
    expect(windows[1].gte.toISOString()).toBe("2026-08-22T16:00:00.000Z")
    expect(windows[1].lt.toISOString()).toBe("2026-08-23T16:00:00.000Z")
    expect(windows[2].gte.toISOString()).toBe("2026-08-20T16:00:00.000Z")
    expect(windows[2].lt.toISOString()).toBe("2026-08-21T16:00:00.000Z")
  })

  it("个人 T-3：命中窗口的用户收「3 天后到期」；邮箱为空跳过", async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([
        {
          id: 1,
          username: "张三",
          email: "a@x.com",
          subscriptionExpiresAt: new Date("2026-08-23T01:00:00.000Z"), // 北京 8-23 09:00
        },
        {
          id: 2,
          username: "李四",
          email: null,
          subscriptionExpiresAt: new Date("2026-08-23T02:00:00.000Z"), // 北京 8-23 10:00
        },
      ]) // T-3
      .mockResolvedValueOnce([]) // T-1

    await task.run()

    expect(mail.sendMail).toHaveBeenCalledTimes(1)
    const [to, subject, html] = callArgs<[string, string, string]>(mail.sendMail, 0)
    expect(to).toBe("a@x.com")
    expect(subject).toContain("3 天后到期")
    expect(html).toContain("2026-08-23")
  })

  it("北京日与 UTC 日不同的临界：北京 8-23 00:30（UTC 8-22 16:30）到期 → 命中 T-3 且邮件展示北京日期 2026-08-23", async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([
        {
          id: 1,
          username: "王五",
          email: "w@x.com",
          subscriptionExpiresAt: new Date("2026-08-22T16:30:00.000Z"), // = 北京 2026-08-23 00:30
        },
      ]) // T-3
      .mockResolvedValueOnce([]) // T-1

    await task.run()

    expect(mail.sendMail).toHaveBeenCalledTimes(1)
    const [, , html] = callArgs<[string, string, string]>(mail.sendMail, 0)
    expect(html).toContain("2026-08-23") // 北京日期
    expect(html).not.toContain("2026-08-22") // 不得展示 UTC 日期（旧 bug）
  })

  it("团队：T-7/3/1 各查一次 ACTIVE，命中收「N 天后到期」", async () => {
    prisma.team.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([]) // T-3
      .mockResolvedValueOnce([
        {
          id: 10,
          name: "Acme",
          expiresAt: new Date("2026-08-21T00:00:00.000Z"), // 北京 8-21 08:00
          admin: { username: "老板", email: "boss@x.com" },
        },
      ]) // T-1

    await task.run()

    expect(prisma.team.findMany).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i++) {
      expect(
        callArgs<[{ where: { status: string } }]>(prisma.team.findMany, i)[0].where.status
      ).toBe("ACTIVE")
    }
    expect(mail.sendMail).toHaveBeenCalledTimes(1)
    const [to, subject, html] = callArgs<[string, string, string]>(mail.sendMail, 0)
    expect(to).toBe("boss@x.com")
    expect(subject).toContain("1 天后到期")
    expect(html).toContain("Acme")
  })

  it("单封失败不阻塞其它（catch 后继续）", async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([
        {
          id: 1,
          username: "甲",
          email: "a@x.com",
          subscriptionExpiresAt: new Date("2026-08-27T01:00:00.000Z"), // 北京 8-27 09:00（T-7 窗口）
        },
        {
          id: 2,
          username: "乙",
          email: "b@x.com",
          subscriptionExpiresAt: new Date("2026-08-27T02:00:00.000Z"), // 北京 8-27 10:00
        },
      ])
      .mockResolvedValue([])
    mail.sendMail.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValue(undefined)

    await task.run()

    expect(mail.sendMail).toHaveBeenCalledTimes(2)
  })
})
