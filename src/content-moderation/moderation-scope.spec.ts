import { DispatchQueueService } from "../image-generation/executor/dispatch-queue.service"
import { contentInputs } from "./content-inputs"
import {
  createModerationScope,
  moderationScope,
  requestContentInputs,
  setStoredModerationPrompts,
} from "./moderation-scope"

describe("请求审核上下文", () => {
  it("后台图片调度保留各请求的用户提示词，排队后也不串用其他请求", async () => {
    const queue = new DispatchQueueService()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const seen: string[] = []
    const jobs: Promise<void>[] = []
    for (let index = 0; index < 10; index++) {
      const prompt = `用户${index}`
      const scope = createModerationScope(() => Promise.resolve(contentInputs({ prompt })))
      jobs.push(
        new Promise<void>((resolve, reject) => {
          moderationScope.run(scope, () =>
            queue.enqueue(async () => {
              try {
                await gate
                const inputs = await requestContentInputs(contentInputs({ prompt: "后端模板" }))
                expect(inputs[0].content).toBe(prompt)
                seen.push(prompt)
                resolve()
              } catch (error) {
                reject(error)
              }
            })
          )
        })
      )
    }
    release()
    await Promise.all(jobs)
    expect(new Set(seen).size).toBe(10)
    expect(moderationScope.getStore()).toBeUndefined()
  })

  it("从数据库读取的多个分镜提示词先合并，用户显式传入的提示词保持优先", async () => {
    for (const original of [[], contentInputs({ prompt: "当前请求" })]) {
      await moderationScope.run(
        createModerationScope(() => Promise.resolve(original)),
        async () => {
          await setStoredModerationPrompts(["分镜一", "分镜二", "分镜一"])
          expect(
            (await requestContentInputs(contentInputs({ prompt: "拼接模板" })))[0].content
          ).toBe(original.length ? "当前请求" : "分镜一\n\n分镜二")
        }
      )
    }
  })
})
