import { validate } from "class-validator"
import { AiGatewayVideoQuoteDto, AiGatewayVideoRequestDto } from "./ai-gateway-model.dto"

describe("AiGatewayVideoRequestDto", () => {
  it("生成任务仍拒绝缺少 prompt 的参数", async () => {
    const dto = Object.assign(new AiGatewayVideoRequestDto(), {
      category: "NORMAL",
      publicId: "sourcing-test-video",
      params: { duration_seconds: 5 },
    })

    const errors = await validate(dto)

    expect(errors.find(error => error.property === "params")?.constraints).toEqual(
      expect.objectContaining({ aiGatewayVideoParams: "params.prompt 必须是非空字符串" })
    )
  })
})

describe("AiGatewayVideoQuoteDto", () => {
  const create = (params: unknown) =>
    Object.assign(new AiGatewayVideoQuoteDto(), {
      category: "NORMAL",
      publicId: "sourcing-test-video",
      params,
    })

  it.each([
    {},
    { mode: "image_to_video", resolution: "720p" },
    { prompt: "兼容旧请求", duration_seconds: 5, resolution: "480p" },
  ])("报价仅校验配置，允许不传提示词和时长：%j", async params => {
    expect(await validate(create(params))).toEqual([])
  })

  it.each([undefined, null, [], "720p", { mode: 123 }, { resolution: {} }])(
    "拒绝无效报价配置：%j",
    async params => {
      expect((await validate(create(params))).some(error => error.property === "params")).toBe(true)
    }
  )

  it("报价仍需模型和业务分类", async () => {
    const dto = Object.assign(new AiGatewayVideoQuoteDto(), { params: {} })
    expect((await validate(dto)).map(error => error.property).sort()).toEqual([
      "category",
      "publicId",
    ])
  })
})
