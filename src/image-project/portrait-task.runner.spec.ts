import { BadGatewayException } from "@nestjs/common"
import { PortraitTaskRunner } from "./portrait-task.runner"

describe("PortraitTaskRunner", () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const task = {
      id: 31,
      projectId: 5,
      userId: 7,
      type: "PORTRAIT",
      status: "GENERATING",
      gatewayTaskId: null,
      prompt: "完整提示词",
      promptConfig: {
        references: [{ url: "https://example.com/ref.png", purpose: "参考脸型" }],
        model_params: { size: "2048x2048", quality: "standard", output_format: "png" },
      },
      model: "ZQ-Image-1",
      aspectRatio: "3:4",
      generatedImages: [
        { id: 101, status: "GENERATING", providerJobId: null },
        { id: 102, status: "GENERATING", providerJobId: null },
      ],
      ...overrides,
    }
    const tx = {
      generationTask: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      generatedImage: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        count: jest.fn().mockResolvedValue(0),
      },
      imageProject: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = {
      generationTask: {
        findUnique: jest.fn().mockResolvedValue(task),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const generator = {
      isAvailable: jest.fn().mockReturnValue(true),
      submit: jest.fn().mockResolvedValue({ jobId: "image_task_1" }),
    }
    const runner = new PortraitTaskRunner(prisma as never, generator)
    return { runner, prisma, tx, generator }
  }

  it("统一重绘的任务由共享执行器负责，恢复时不重复调用人像生成", async () => {
    const { runner, generator, tx } = setup({ executionSpec: { kind: "IMAGE_CREATIVE_GENERATE", localRedraw: { provider: "ZQ-Image-2" } } })
    await runner.run(31)
    expect(generator.submit).not.toHaveBeenCalled()
    expect(tx.generationTask.updateMany).not.toHaveBeenCalled()
  })

  it("原生任务透传已校验标记与档位原值，不追加本地裁剪构图指令", async () => {
    const { runner, generator } = setup({
      deliveryPlan: { nativeSizing: true, cropAnchor: "centre", requested: { aspectRatio: "21:9" } },
      promptConfig: { model_params: { aspect_ratio: "21:9", resolution: "2K" } },
    })
    await runner.run(31)
    expect(generator.submit).toHaveBeenCalledWith(expect.objectContaining({
      nativeSizing: true, prompt: "完整提示词",
      modelParams: { aspect_ratio: "21:9", resolution: "2K" },
    }))
  })

  it("只提交 Gateway 并保存任务关联，不查询远端状态", async () => {
    const { runner, tx, generator } = setup()

    await runner.run(31)

    expect(generator.submit).toHaveBeenCalledWith({
      taskId: 31,
      prompt: "完整提示词",
      model: "ZQ-Image-1",
      quantity: 2,
      referenceImages: [{ url: "https://example.com/ref.png", purpose: "参考脸型" }],
      modelParams: { size: "2048x2048", quality: "standard", output_format: "png" },
      idempotencyKey: "portrait-generation-task:31",
    })
    expect(tx.generationTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 31,
        status: "GENERATING",
        gatewayTaskId: null,
        deletedAt: null,
      },
      data: { gatewayTaskId: "image_task_1" },
    })
    expect(tx.generatedImage.updateMany).toHaveBeenCalledWith({
      where: { taskId: 31, deletedAt: null, status: "GENERATING" },
      data: { providerJobId: "image_task_1" },
    })
    expect("query" in generator).toBe(false)
  })

  it("已关联 Gateway 的任务不会再次提交", async () => {
    const { runner, generator } = setup({ gatewayTaskId: "image_task_existing" })

    await runner.run(31)

    expect(generator.submit).not.toHaveBeenCalled()
  })

  it("恢复任务提交前按冻结交付目标覆盖冲突的旧尺寸快照", async () => {
    const { runner, generator } = setup({
      deliveryPlan: { requested: { aspectRatio: "463:625", resolutionTier: "2K" } },
      promptConfig: { model_params: {
        aspect_ratio: "3:2", size: "1728x2304", resolution: "4k",
        width: 1920, height: 1080, resolution_tier: "1K", quality: "standard",
      } },
    })
    await runner.run(31)
    expect(generator.submit).toHaveBeenCalledWith(expect.objectContaining({
      modelParams: { aspect_ratio: "463:625", resolution: "2k", quality: "standard" },
    }))
  })

  it("新快照的安全构图用用户目标比例，不用模型适配比例", async () => {
    const { runner, generator } = setup({
      deliveryPlan: { cropAnchor: "centre", requested: { aspectRatio: "10:3" } },
    })
    await runner.run(31)
    expect(generator.submit.mock.calls[0][0].prompt).toContain("最终交付目标为宽高比 10:3")
    expect(generator.submit.mock.calls[0][0].prompt.match(/中心裁剪安全构图：/g)).toHaveLength(1)
  })

  it("Gateway 提交结果不确定时保留 GENERATING 等待回调或启动恢复", async () => {
    const { runner, tx, generator } = setup()
    generator.submit.mockRejectedValue(new BadGatewayException("网络中断"))

    await runner.run(31)

    expect(tx.generationTask.updateMany).not.toHaveBeenCalled()
    expect(tx.generatedImage.updateMany).not.toHaveBeenCalled()
  })
})
