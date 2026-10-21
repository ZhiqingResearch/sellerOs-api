import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { AiGatewayPortraitImageGenerator } from "./ai-gateway-portrait-image.generator"

describe("AiGatewayPortraitImageGenerator", () => {
  const gateway = {
    isConfigured: jest.fn(),
    createImageTask: jest.fn(),
  }
  const generator = new AiGatewayPortraitImageGenerator(gateway as unknown as AiGatewayProvider)

  beforeEach(() => jest.clearAllMocks())

  it("原生任务保留网关档位枚举原值", async () => {
    gateway.createImageTask.mockResolvedValue({ id: "native-task" })
    await generator.submit({
      taskId: 31, nativeSizing: true, prompt: "原生图片", model: "ZQ-Image-1",
      quantity: 1, referenceImages: [], modelParams: { aspect_ratio: "21:9", resolution: "2K" },
      idempotencyKey: "portrait-generation-task:31",
    })
    expect(gateway.createImageTask).toHaveBeenCalledWith(
      expect.objectContaining({ aspect_ratio: "21:9", resolution: "2K" }),
      "portrait-generation-task:31"
    )
  })

  it("把人像参数和稳定幂等键提交给 AI Gateway", async () => {
    gateway.createImageTask.mockResolvedValue({ id: "image_task_1" })

    await expect(
      generator.submit({
        taskId: 31,
        prompt: "完整人像提示词",
        model: "ZQ-Image-1",
        quantity: 2,
        referenceImages: [{ url: "https://example.com/ref.png", purpose: "参考人物脸型" }],
        modelParams: {
          size: "2048x2048",
          quality: "standard",
          output_format: "png",
        },
        idempotencyKey: "portrait-generation-task:31",
      })
    ).resolves.toEqual({ jobId: "image_task_1" })

    expect(gateway.createImageTask).toHaveBeenCalledWith(
      {
        model: "ZQ-Image-1",
        prompt: "完整人像提示词",
        operation: "edit",
        n: 2,
        size: "2048x2048",
        quality: "standard",
        output_format: "png",
        callback: true,
        reference_images: [{ url: "https://example.com/ref.png" }],
      },
      "portrait-generation-task:31"
    )
  })
})
