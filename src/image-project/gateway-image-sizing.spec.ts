import { buildPortraitImageTaskRequest } from "./portrait-image-generator"

describe("Gateway 图片尺寸参数", () => {
  const input = { model: "ZQ-Image-Ultra", prompt: "小女孩", quantity: 1, referenceImages: [] }
  it("小写归一档位，并保留结构化比例", () => {
    expect(
      buildPortraitImageTaskRequest({
        ...input,
        modelParams: { aspect_ratio: "4:5", resolution: "1K" },
      })
    ).toMatchObject({ aspect_ratio: "4:5", resolution: "1k" })
  })
  it("像素尺寸与比例/档位一致时允许同时提交", () => {
    expect(
      buildPortraitImageTaskRequest({
        ...input,
        modelParams: { size: "819x1024", aspect_ratio: "4:5", resolution: "1K" },
      })
    ).toMatchObject({ size: "819x1024", aspect_ratio: "4:5", resolution: "1k" })
  })
  it.each([
    { size: "1024x1536", aspect_ratio: "4:5" },
    { size: "819x1024", resolution: "2k" },
    { size: "819x1024", resolution: "1638x2048" },
    { aspect_ratio: "0:5", resolution: "1k" },
  ])("拒绝冲突或无效尺寸 %j", modelParams => {
    expect(() => buildPortraitImageTaskRequest({ ...input, modelParams })).toThrow()
  })
})
