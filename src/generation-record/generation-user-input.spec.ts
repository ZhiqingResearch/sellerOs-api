import { generationUserInput, inputString } from "./generation-user-input"

const raw = "  前端原文\r\n第二行\nNegative prompt: 用户自己写的内容  "

describe("生成记录原样保存现有前端输入", () => {
  it.each([
    ["history", { title: "自动标题", data: { params: { keyword: raw } } }],
    ["businessAiRun", { billing: { userInput: raw, sourceFacts: { title: "提取标题" } } }],
    ["asinAuditRecord", { asin: raw, productTitle: "提取标题" }],
    ["asinEvidenceRecord", { asin: raw, productTitle: "提取标题" }],
    ["selectionAnalysisRecord", { steps: [{ payload: { sourceText: raw } }] }],
    ["smartPricingRecord", { product: { sourceText: raw, name: "提取商品名" } }],
    ["competitorAnalysisRecord", { title: "自动报告标题", inputSnapshot: { sourceText: raw } }],
    ["generationTask", { type: "PORTRAIT", prompt: raw, promptConfig: { modules: {} } }],
    ["generationTask", { prompt: "后端编译稿", executionSpec: { userInput: raw } }],
    ["imageGenJob", { request: { userInput: raw, prompt: "后端拼接稿" } }],
    ["imageGenJob", { kind: "IMAGE_TO_IMAGE", request: { prompt: raw } }],
    ["videoTask", { prompt: "后端默认稿", deliveryMeta: { userInput: raw } }],
    ["storyboardVideo", { generationParams: { prompt: raw } }],
    ["rpaCreationTask", { prompt: raw }],
  ])("%s 不修剪、不改写、不拼接", (source, row) => {
    expect(generationUserInput(source, row)).toBe(raw)
  })

  it.each([
    ["categoryAnalysisRecord", { keywords: [raw], title: "自动标题" }, [raw]],
    [
      "promotionPlanRecord",
      { input: { productText: raw, competitorLinks: ["B0DSGRHL7C"] } },
      { productText: raw, competitorLinks: ["B0DSGRHL7C"] },
    ],
    [
      "chetaidouTask",
      { input: { answers: [{ text: raw }] }, snapshot: { prompt: "后端系统模板" } },
      { answers: [{ text: raw }] },
    ],
    ["beautyTask", { beautyInput: { style: raw }, prompt: "模型执行稿" }, { style: raw }],
    ["inspirationSubscription", { keywords: [raw], name: "订阅名" }, [raw]],
  ])("%s 结构化输入可无损读取，不拼接摘要", (source, row, expected) => {
    expect(JSON.parse(generationUserInput(source, row))).toEqual(expected)
  })

  it("空串保留，不用其他字段兜底", () => {
    expect(
      generationUserInput("smartPricingRecord", {
        product: { sourceText: "", sourceUrl: "不能替换" },
      })
    ).toBe("")
    expect(
      generationUserInput("videoTask", { deliveryMeta: { userInput: "" }, prompt: "不能替换" })
    ).toBe("")
    expect(inputString(undefined)).toBe("")
  })
})
