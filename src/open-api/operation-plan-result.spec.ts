import { BadGatewayException } from "@nestjs/common"
import {
  buildOperationPlanResult,
  describeOperationPlanIssues,
  normalizeOperationPlanInput,
  parseOperationPlans,
} from "./operation-plan-result"
import { OperationPlanInput } from "./operation-plan.types"

export const PLAN_TEST_INPUT: OperationPlanInput = {
  requestId: "test-1",
  productText: "便携榨汁杯",
  market: "amazon_us",
  category: "家居",
  operationMode: "jingpin",
  currentPrice: 699,
  startDate: "2026-09-22",
  competitors: [
    { productId: "B001", platform: "amazon", price: 657.06, currency: "USD" },
    { productId: "B002", platform: "amazon", price: 537.88, currency: "USD" },
  ],
}
export function planTestOutput() {
  return {
    recommendedPlanId: "steady",
    plans: ["lowprice", "steady", "premium"].map(id => ({
      id,
      summary: "根据商品特点分阶段投放",
      suggestedPrice: 699,
      benchmarkCompetitorIds: ["amazon:B001"],
      tasks: [
        { taskName: "准备素材", phase: "prep", startDay: 1, endDay: 14 },
        { taskName: "定价", phase: "prep", startDay: 1, endDay: 7 },
        { taskName: "试投", phase: "launch", startDay: 10, endDay: 35 },
        { taskName: "扩词", phase: "grow", startDay: 36, endDay: 70 },
        { taskName: "复盘", phase: "opt", startDay: 60, endDay: 90 },
      ],
    })),
  }
}

describe("运营计划交付结构", () => {
  it("汇总线上样本的错误竞品、缺失阶段和缺失方案，交付仍拒绝", () => {
    const output = planTestOutput()
    output.plans[0].tasks = output.plans[0].tasks.filter(task => task.phase !== "grow")
    output.plans[2].id = "bundle"
    const input = { ...PLAN_TEST_INPUT, competitors: [] }
    const text = JSON.stringify(output)
    const issues = describeOperationPlanIssues(text, input)
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lowprice.tasks缺少grow"),
        expect.stringContaining("lowprice.benchmarkCompetitorIds"),
        expect.stringContaining("plans缺少必需方案premium"),
      ])
    )
    expect(() => parseOperationPlans(text, input)).toThrow(BadGatewayException)
  })
  it("均价/价差由有效输入计算，并生成含端点的日排期", () => {
    const result = buildOperationPlanResult(
      JSON.stringify(planTestOutput()),
      PLAN_TEST_INPUT,
      "2026-09-22T08:00:00Z"
    )
    expect(result.competitorAveragePrice).toBe(597.47)
    expect(result.priceDifferencePercent).toBe(16.99)
    expect(result.plans[0].tasks[0]).toMatchObject({
      startDate: "2026-09-22",
      endDate: "2026-10-05",
    })
    expect(result.plans[0].tasks[4].endDate).toBe("2026-12-20")
  })
  it("不混算币种或以零代替缺失价", () => {
    const input = {
      ...PLAN_TEST_INPUT,
      competitors: PLAN_TEST_INPUT.competitors.map((item, i) => ({
        ...item,
        currency: i ? "EUR" : "USD",
        price: undefined,
      })),
    }
    const result = buildOperationPlanResult(JSON.stringify(planTestOutput()), input, "now")
    expect(result.competitorAveragePrice).toBeNull()
    expect(result.priceDifferencePercent).toBeNull()
    expect(result.pricedCompetitorCount).toBe(0)
  })
  it("禁止重复竞品，空白与字段顺序规范化", () => {
    expect(() =>
      normalizeOperationPlanInput({
        ...PLAN_TEST_INPUT,
        competitors: [PLAN_TEST_INPUT.competitors[0], PLAN_TEST_INPUT.competitors[0]],
      })
    ).toThrow("竞品商品标识不能重复")
    expect(
      normalizeOperationPlanInput({ ...PLAN_TEST_INPUT, productText: "  便携榨汁杯 " })
    ).toEqual(PLAN_TEST_INPUT)
  })
  it.each([
    "invalid-json",
    "day",
    "phase",
    "competitor",
    "duplicate-plan",
    "recommendation",
    "price",
  ])("拒绝非法模型输出：%s", kind => {
    const output = planTestOutput()
    if (kind === "day") output.plans[0].tasks[0].endDay = 91
    if (kind === "phase") output.plans[0].tasks[0].phase = "unknown"
    if (kind === "competitor") output.plans[0].benchmarkCompetitorIds = ["amazon:FAKE"]
    if (kind === "duplicate-plan") output.plans[0].id = "steady"
    if (kind === "recommendation") output.recommendedPlanId = "bundle"
    if (kind === "price") output.plans[0].suggestedPrice = -1
    expect(() =>
      parseOperationPlans(kind === "invalid-json" ? "abc" : JSON.stringify(output), PLAN_TEST_INPUT)
    ).toThrow(BadGatewayException)
  })
})
