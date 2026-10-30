import type { ProviderGenerateInput } from "../image-generation/core/types"
import { GenerationTaskRunnerService } from "../image-generation/executor/generation-task-runner.service"
import { hostImage } from "../image-generation/executor/host-image"
import { ImageGenItemRunnerService } from "../image-generation/executor/image-gen-item-runner.service"

jest.mock("../image-generation/executor/host-image", () => ({ hostImage: jest.fn() }))
jest.mock("../image-generation/executor/delivered-image-dimensions", () => ({
  resolveDeliveredImageDimensions: jest.fn(() => Promise.resolve({ width: 400, height: 300 })),
}))

describe("生成结果先落库，图片标识重试不再生成", () => {
  it.each(["generate", "imagegen"])("%s 标识失败后恢复只调用一次生成", async kind => {
    jest.useFakeTimers()
    try {
      const generation = kind === "generate"
      const task = {
        id: generation ? 8 : "job",
        status: "GENERATING",
        businessType: "IMAGE_CREATIVE",
        kind: "TEXT_TO_IMAGE",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        executionSpec: {
          kind: "IMAGE_CREATIVE_GENERATE",
          provider: "model",
          items: [{ order: 0 }],
        },
        request: { provider: "model" },
      }
      const row: Record<string, any> = {
        id: 1,
        status: generation ? "GENERATING" : "QUEUED",
        attemptNo: 0,
        order: 0,
        idx: 0,
        task,
        job: { ...task, status: "RUNNING" },
        deliverySource: null,
      }
      const updateMany = jest.fn(({ where, data }) => {
        if (typeof where.status === "string" && where.status !== row.status)
          return Promise.resolve({ count: 0 })
        Object.assign(row, data, {
          attemptNo: typeof data.attemptNo === "object" ? row.attemptNo + 1 : row.attemptNo,
        })
        return Promise.resolve({ count: 1 })
      })
      const table = { updateMany, findUnique: jest.fn(() => Promise.resolve(structuredClone(row))) }
      const db = {
        generatedImage: table,
        imageGenItem: table,
        generationTask: { findUnique: jest.fn().mockResolvedValue(null) },
        imageGenJob: { findUnique: jest.fn().mockResolvedValue(null) },
      }
      const generate = jest.fn(async (input: ProviderGenerateInput) => {
        await input.onGenerated?.("existing-paid-task")
        return {
          url: "https://vendor.example/generated.png",
          mimeType: "image/png",
          gatewayTaskId: "existing-paid-task",
        }
      })
      const factory = jest.fn(() => ({ id: "model", generate }))
      const runner = generation
        ? new GenerationTaskRunnerService(db as never, factory, {} as never)
        : new ImageGenItemRunnerService(
            db as never,
            factory,
            {} as never,
            { enqueue: jest.fn() } as never
          )
      jest.spyOn(runner as any, "buildProviderInput").mockResolvedValue({ prompt: "生成图片" })
      jest
        .mocked(hostImage)
        .mockRejectedValueOnce(new Error("label failed"))
        .mockResolvedValue("https://cdn.example/aigc/result.png")
      if (!generation)
        jest
          .spyOn(runner as any, "hostArtifactWithRetry")
          .mockImplementation(() => hostImage("source"))
      const execute = () =>
        generation
          ? (runner as GenerationTaskRunnerService).executeGeneratedImage(1)
          : (runner as ImageGenItemRunnerService).executeItem(1)
      await execute()
      expect(row.status).not.toMatch(/SUCCESS|SUCCEEDED/)
      expect(row.deliverySource).toMatchObject({ gatewayTaskId: "existing-paid-task" })
      await execute()
      expect(row.status).toBe(generation ? "SUCCESS" : "SUCCEEDED")
      expect(generate).toHaveBeenCalledTimes(1)
      expect(row.url).toContain("/aigc/")
    } finally {
      jest.clearAllTimers()
      jest.useRealTimers()
      jest.clearAllMocks()
    }
  })
})
