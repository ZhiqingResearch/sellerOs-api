import { contentInputs } from "./content-inputs"
import {
  ModerationPendingException,
  TaskModerationService,
  inputHash,
  moderationSnapshot,
  type ModerationState,
} from "./task-moderation.service"

const passed = { suggestion: "pass", riskLevel: null, dimensions: [] }
const none = {
  suggestion: null,
  riskLevel: "none",
  dimensions: [{ type: null, suggestion: null, level: "none", labels: [] }],
}

function setup() {
  const params = {
    prompt: "展示商品",
    reference_images: [{ url: "https://assets.example/a.png" }],
    reference_videos: [{ url: "https://assets.example/a.mp4" }],
    documentUrl: "https://assets.example/a.pdf",
  }
  let row: Record<string, unknown> = {
    id: 1,
    userId: 7,
    project: { deletedAt: null },
    storyboard: {
      deletedAt: null,
      production: { deletedAt: null, project: { deletedAt: null, customer: { deletedAt: null } } },
    },
    status: "WAITING_MODERATION",
    generationParams: params,
    gatewayTaskId: null,
    moderationStatus: null,
    moderation: null,
    moderationClaimUntil: null,
    moderationNextCheckAt: null,
    deletedAt: null,
  }
  const isDate = (value: unknown): value is Date =>
    Object.prototype.toString.call(value) === "[object Date]"
  const equal = (a: unknown, b: unknown) =>
    isDate(a) && isDate(b) ? a.getTime() === b.getTime() : a === b
  const matches = (
    where: Record<string, unknown>,
    current: Record<string, unknown> = row
  ): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR")
        return (value as Record<string, unknown>[]).some(condition => matches(condition, current))
      if (key === "AND")
        return (value as Record<string, unknown>[]).every(condition => matches(condition, current))
      if (value && typeof value === "object" && !isDate(value)) {
        const condition = value as { in?: unknown[]; lt?: Date; lte?: Date }
        if (condition.in) return condition.in.includes(current[key])
        if (condition.lt) return (current[key] as Date) < condition.lt
        if (condition.lte) return (current[key] as Date) <= condition.lte
        return Boolean(
          current[key] &&
          typeof current[key] === "object" &&
          matches(value as Record<string, unknown>, current[key] as Record<string, unknown>)
        )
      }
      return equal(current[key], value)
    })
  const store = {
    findFirst: jest.fn(async ({ where }) => (matches(where) ? structuredClone(row) : null)),
    findMany: jest.fn(async ({ where }) => (matches(where) ? [structuredClone(row)] : [])),
    updateMany: jest.fn(async ({ where, data }) => {
      if (!matches(where)) return { count: 0 }
      row = { ...row, ...structuredClone(data) }
      return { count: 1 }
    }),
  }
  const provider = {
    validate: jest.fn(),
    service: jest.fn(type =>
      type === "VIDEO" ? "videoDetection" : type === "DOCUMENT" ? "document_detection" : "guard"
    ),
    check: jest.fn().mockResolvedValue(passed),
    submit: jest.fn(async input => ({
      taskId: `vendor-${input.key}`,
      region: "cn-shanghai",
      service: input.type === "VIDEO" ? "videoDetection" : "document_detection",
      requestId: null,
    })),
    poll: jest.fn().mockResolvedValue(none),
    decide: jest.fn(result => (result.suggestion === "block" ? "REJECTED" : "PASSED")),
  }
  const snapshots = {
    freeze: jest.fn(async (value, root) => ({ value, inputs: contentInputs(value, root) })),
  }
  const service = new TaskModerationService(
    { videoTask: store, storyboardVideo: store, beautyTask: store } as never,
    provider as never,
    snapshots as never
  )
  const continuation = jest.fn(async () => undefined)
  service.registerContinuation(continuation)
  return {
    service,
    provider,
    store,
    params,
    snapshots,
    continuation,
    row: () => row,
    change: (data: Record<string, unknown>) => {
      row = { ...row, ...data }
    },
  }
}

describe("业务前置审核状态机", () => {
  it("同一任务全部文本、图片、视频、文档通过后才允许提交，并用CAS阻止并发重复提交", async () => {
    const ctx = setup()
    await expect(ctx.service.requirePassed("video-task:1", ctx.params)).rejects.toBeInstanceOf(
      ModerationPendingException
    )
    expect(ctx.row()).toMatchObject({
      status: "WAITING_MODERATION",
      moderationStatus: "PROCESSING",
    })
    expect(ctx.provider.submit).toHaveBeenCalledTimes(2)
    expect(ctx.continuation).not.toHaveBeenCalled()
    await ctx.service.refresh("video-task:1")
    expect(ctx.row().moderationStatus).toBe("PASSED")
    expect(ctx.continuation).toHaveBeenCalledTimes(1)
    await expect(ctx.service.requirePassed("video-task:1", ctx.params)).resolves.toEqual(ctx.params)
    await expect(ctx.service.requirePassed("video-task:1", ctx.params)).rejects.toBeInstanceOf(
      ModerationPendingException
    )
    expect(ctx.provider.submit).toHaveBeenCalledTimes(2)
  })

  it("前端主动轮询不受30秒定时查询间隔限制，查询仍未完成时不重复提交审核", async () => {
    const ctx = setup()
    ctx.provider.poll.mockResolvedValue(null)
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    await ctx.service.refresh("video-task:1")
    await ctx.service.refresh("video-task:1")
    expect(ctx.provider.poll).toHaveBeenCalledTimes(4)
    expect(ctx.provider.submit).toHaveBeenCalledTimes(2)
    expect(ctx.row().moderationStatus).toBe("PROCESSING")
    expect(ctx.continuation).not.toHaveBeenCalled()
  })

  it("同步拒绝立即结束本轮，不提交后续媒体或继续业务", async () => {
    const ctx = setup()
    ctx.provider.check.mockResolvedValue({ ...passed, suggestion: "block" })
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    expect(ctx.row()).toMatchObject({ status: "FAILED", moderationStatus: "REJECTED" })
    expect(ctx.provider.submit).not.toHaveBeenCalled()
    await ctx.service.refresh("video-task:1")
    expect(ctx.continuation).not.toHaveBeenCalled()
  })

  it("提交结果未知及进程遗留SUBMITTING不能自动重新提交", async () => {
    const ctx = setup()
    ctx.provider.submit.mockRejectedValue(new Error("timeout"))
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    expect(ctx.row()).toMatchObject({ status: "FAILED", moderationStatus: "FAILED" })
    const count = ctx.provider.submit.mock.calls.length
    await ctx.service.refresh("video-task:1")
    expect(ctx.provider.submit).toHaveBeenCalledTimes(count)

    const second = setup()
    await second.service.requirePassed("video-task:1", second.params).catch(() => undefined)
    const state = second.row().moderation as ModerationState
    state.items.find(item => item.input.type === "VIDEO")!.status = "SUBMITTING"
    second.change({ moderation: state })
    second.provider.submit.mockClear()
    await second.service.refresh("video-task:1")
    expect(second.row().moderationStatus).toBe("FAILED")
    expect(second.provider.submit).not.toHaveBeenCalled()
  })

  it("查询失败保留任务ID和PROCESSING，恢复后继续查询而不是重新提交", async () => {
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    ctx.provider.poll.mockRejectedValueOnce(new Error("temporary"))
    await ctx.service.refresh("video-task:1")
    expect(ctx.row().moderationStatus).toBe("PROCESSING")
    expect(moderationSnapshot(ctx.row()).refreshError).toMatchObject({
      code: "MODERATION_REFRESH_UNAVAILABLE",
    })
    await ctx.service.refresh("video-task:1")
    expect(ctx.row().moderationStatus).toBe("PASSED")
    expect(ctx.provider.submit).toHaveBeenCalledTimes(2)
  })

  it("取消、删除或输入变化后不再调用下游；查询期间取消也阻止更新和继续", async () => {
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    ctx.provider.poll.mockImplementationOnce(async () => {
      ctx.change({ status: "CANCELLED" })
      return none
    })
    await ctx.service.refresh("video-task:1").catch(() => undefined)
    expect(ctx.row().status).toBe("CANCELLED")
    expect(ctx.continuation).not.toHaveBeenCalled()
    ctx.provider.poll.mockClear()
    await ctx.service.refresh("video-task:1")
    expect(ctx.provider.poll).not.toHaveBeenCalled()
    ctx.change({ deletedAt: new Date() })
    await expect(ctx.service.refresh("video-task:1")).rejects.toMatchObject({ status: 404 })
  })

  it("内容hash按对象键排序，与MySQL JSON字段重排兼容；不同输入不能复用结果", async () => {
    expect(inputHash({ a: 1, b: { c: 2, d: 3 } })).toBe(inputHash({ b: { d: 3, c: 2 }, a: 1 }))
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    ctx.change({ generationParams: { ...ctx.params, prompt: "已改变" } })
    await ctx.service.refresh("video-task:1")
    expect(ctx.row()).toMatchObject({ status: "FAILED", moderationStatus: "FAILED" })
    expect(ctx.continuation).not.toHaveBeenCalled()
  })

  it("两个并发轮询仅有一个查询供应商，结果摘要不暴露输入和供应商任务ID", async () => {
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    let resolve!: (result: typeof none) => void
    ctx.provider.poll.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const first = ctx.service.refresh("video-task:1")
    for (let i = 0; i < 100 && !resolve; i++) await Promise.resolve()
    expect(resolve).toBeDefined()
    await ctx.service.refresh("video-task:1")
    expect(ctx.provider.poll).toHaveBeenCalledTimes(1)
    resolve(none)
    await first
    const summary = JSON.stringify(moderationSnapshot(ctx.row()))
    expect(summary).not.toContain("https://")
    expect(summary).not.toContain("展示商品")
    expect(summary).not.toContain("vendor-")
  })

  it("用户归属检查失败时不查询供应商，不允许任意表名或非法任务ID", async () => {
    const ctx = setup()
    await expect(ctx.service.ownedKey("VIDEO_TASK", "1", 8)).rejects.toMatchObject({ status: 404 })
    await expect(ctx.service.refresh("user:1")).rejects.toMatchObject({ status: 404 })
    await expect(ctx.service.refresh("video-task:1e9")).rejects.toMatchObject({ status: 404 })
    expect(ctx.provider.poll).not.toHaveBeenCalled()
  })

  it("父项目已删除时即使任务行仍存在也不能审核或继续", async () => {
    const ctx = setup()
    ctx.change({ project: { deletedAt: new Date() } })
    await expect(ctx.service.refresh("video-task:1")).rejects.toMatchObject({ status: 404 })
    expect(ctx.provider.submit).not.toHaveBeenCalled()
    expect(ctx.continuation).not.toHaveBeenCalled()
  })

  it("查询超时任务只读快照，不把未提交业务的旧任务重新启动", async () => {
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    await ctx.service.refresh("video-task:1", false)
    ctx.change({ status: "TIMEOUT" })
    const row = await ctx.service.refresh("video-task:1")
    expect(row.status).toBe("TIMEOUT")
    expect(ctx.continuation).not.toHaveBeenCalled()
    await expect(ctx.service.requirePassed("video-task:1", ctx.params)).rejects.toMatchObject({
      status: 409,
    })
  })

  it("数据库异常不将待审原文、签名地址或Prisma参数传播到日志", async () => {
    const ctx = setup()
    ctx.store.updateMany.mockRejectedValueOnce(
      new Error("private body https://private.test/signed?token=secret")
    )
    await expect(ctx.service.requirePassed("video-task:1", ctx.params)).rejects.toMatchObject({
      response: { code: "MODERATION_STORAGE_UNAVAILABLE" },
    })
    expect(ctx.provider.submit).not.toHaveBeenCalled()
  })

  it("提交阶段持久化后恢复关联不再检查余额；历史提交未知的孤儿任务不重新发送", async () => {
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    await ctx.service.refresh("video-task:1", false)
    await ctx.service.requirePassed("video-task:1", ctx.params)
    const precheck = jest.fn().mockResolvedValue(undefined)
    await ctx.service.beforeBusinessSubmission("video-task:1", precheck)
    await ctx.service.beforeBusinessSubmission("video-task:1", precheck)
    expect(precheck).toHaveBeenCalledTimes(1)
    expect((ctx.row().moderation as ModerationState).businessSubmitting).toBe(true)

    const legacy = setup()
    legacy.change({ status: "GENERATING" })
    await expect(legacy.service.requirePassed("video-task:1", legacy.params)).rejects.toMatchObject(
      { status: 409 }
    )
    expect(legacy.row()).toMatchObject({ status: "FAILED", moderationStatus: "FAILED" })
    expect(legacy.provider.submit).not.toHaveBeenCalled()
    expect(legacy.snapshots.freeze).not.toHaveBeenCalled()
  })

  it("GET只查询已有审核，未提交子项由创建流程或后台提交", async () => {
    const ctx = setup()
    await ctx.service.requirePassed("video-task:1", ctx.params).catch(() => undefined)
    const state = ctx.row().moderation as ModerationState
    const item = state.items.find(item => item.input.type === "DOCUMENT")!
    item.status = "PENDING"
    delete item.receipt
    ctx.change({ moderation: state })
    ctx.provider.submit.mockClear()
    await ctx.service.refresh("video-task:1")
    expect(ctx.provider.submit).not.toHaveBeenCalled()
    expect(ctx.row().moderationStatus).toBe("PROCESSING")
    await ctx.service.refresh("video-task:1", true, true)
    expect(ctx.provider.submit).toHaveBeenCalledTimes(1)
  })
})
