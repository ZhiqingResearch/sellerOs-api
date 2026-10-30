import { BadRequestException } from "@nestjs/common"
import {
  auditText,
  auditTextStream,
  logRejectedInput,
  recordReview,
  textAuditContext,
  type TextAuditContext,
} from "./text-audit"

function context(userId = 7) {
  const entries: Record<string, unknown>[] = []
  const value: TextAuditContext = {
    requestId: `request-${userId}`,
    userId: () => userId,
    question: () => ({ prompt: "如何制作商品介绍", password: "secret", token: "opaque" }),
    review: "PASSED",
    displayName: jest.fn().mockResolvedValue("模型展示名"),
    write: entry => {
      entries.push(structuredClone(entry))
      return Promise.resolve()
    },
  }
  return { value, entries }
}

describe("文生文只打印后台审计信息", () => {
  it("同一请求的并行子调用审核状态彼此隔离", async () => {
    const ctx = context()
    await textAuditContext.run(ctx.value, () =>
      Promise.allSettled([
        auditText("model", "正常", async () => {
          recordReview("PASSED")
          await Promise.resolve()
          return "ok"
        }),
        auditText("model", "拒绝", () => {
          recordReview("REJECTED")
          return Promise.reject(new BadRequestException({ code: "MODERATION_REJECTED" }))
        }),
      ])
    )
    expect(
      ctx.entries.some(
        entry => entry.generationStatus === "SUCCEEDED" && entry.moderationStatus === "PASSED"
      )
    ).toBe(true)
    expect(
      ctx.entries.some(
        entry => entry.generationStatus === "NOT_STARTED" && entry.moderationStatus === "REJECTED"
      )
    ).toBe(true)
    expect(ctx.value.review).toBe("PASSED")
  })
  it("只记录displayName，保留调用时名称快照，不包含密码、Token或完整回答", async () => {
    const ctx = context()
    await textAuditContext.run(ctx.value, () =>
      auditText("internal-model-id", "编译后的提示词", () => {
        ctx.value.displayName = jest.fn().mockResolvedValue("新模型名称")
        return Promise.resolve("private answer")
      })
    )
    expect(ctx.entries).toHaveLength(2)
    expect(ctx.entries[1]).toMatchObject({
      userId: 7,
      displayName: "模型展示名",
      moderationStatus: "PASSED",
      generationStatus: "SUCCEEDED",
      question: ["如何制作商品介绍"],
    })
    expect(JSON.stringify(ctx.entries)).not.toMatch(
      /internal-model-id|secret|opaque|private answer/
    )
  })

  it("审核拒绝记录未执行，原异常继续抛出", async () => {
    const ctx = context()
    const refusal = new BadRequestException({ code: "MODERATION_REJECTED" })
    await expect(
      textAuditContext.run(ctx.value, () =>
        auditText("model", "问题", async () => {
          recordReview("REJECTED")
          throw refusal
        })
      )
    ).rejects.toBe(refusal)
    expect(ctx.entries[1]).toMatchObject({
      moderationStatus: "REJECTED",
      generationStatus: "NOT_STARTED",
    })
  })

  it("全局参数审核提前拒绝也留下记录，同一次请求不重复打印", async () => {
    const ctx = context()
    await textAuditContext.run(ctx.value, async () => {
      const refusal = new BadRequestException({ code: "MODERATION_REJECTED" })
      await logRejectedInput(refusal)
      await logRejectedInput(refusal)
    })
    expect(ctx.entries).toHaveLength(1)
    expect(ctx.entries[0]).toMatchObject({
      generationStatus: "NOT_STARTED",
      moderationStatus: "REJECTED",
    })
  })

  it("并发用户和流式中断不串日志、不误记成功", async () => {
    const a = context(1),
      b = context(2)
    await Promise.all(
      [a, b].map(ctx =>
        textAuditContext.run(ctx.value, async () => {
          const stream = auditTextStream("model", "问题", async function* () {
            yield "partial"
            yield "rest"
          })
          await stream.next()
          await stream.return(undefined)
        })
      )
    )
    expect(a.entries[1]).toMatchObject({
      userId: 1,
      requestId: "request-1",
      generationStatus: "CANCELLED",
    })
    expect(b.entries[1]).toMatchObject({
      userId: 2,
      requestId: "request-2",
      generationStatus: "CANCELLED",
    })
  })
})
