import { CreateCompetitorAnalysisRecordDto } from "./dto/create-competitor-analysis-record.dto"

export function createCompetitorAnalysisDto(): CreateCompetitorAnalysisRecordDto {
  return {
    clientRequestId: "9c82fc0e-f74f-4bb8-9075-223ba56d24aa",
    schemaVersion: 1,
    marketplace: "US",
    input: {
      mode: "ASIN",
      ownAsin: "B0AAAA0001",
      competitorAsins: ["B0BBBB0002", "B0CCCC0003"],
      keyword: null,
      sourceText: "前端原始输入",
    },
    summary: { untrustedTitle: "不能覆盖服务端摘要" },
    analysisResult: { overview: { opportunity: "high" } },
    products: [
      {
        asin: "B0AAAA0001",
        sortOrder: 0,
        productData: { title: "我方产品", price: 29.99 },
        steps: [
          {
            stepCode: "PROFILE",
            stepNo: 1,
            schemaVersion: 1,
            resultData: { strengths: ["轻量"] },
          },
        ],
      },
    ],
    reportData: { conclusion: "可进入下一阶段" },
  }
}
