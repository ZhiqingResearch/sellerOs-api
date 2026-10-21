import { OperationPlanInput } from "./operation-plan.types"
import {
  buildSingleOperationPlanResult,
  describeSinglePlanIssues,
  parseSingleOperationPlan,
} from "./single-operation-plan"

const INPUT: OperationPlanInput = {
  schemaVersion: 2,
  requestId: "test",
  productText: "商品",
  market: "amazon_us",
  category: "家居",
  operationMode: "jingpin",
  currentPrice: 12,
  startDate: "2026-09-22",
  competitors: [],
}
function output() {
  return {
    summary: "统一运营建议",
    tasks: ["prep", "launch", "grow", "opt", "opt"].map((phase, index) => ({
      taskName: `任务${index}`,
      phase,
      startDay: index * 15 + 1,
      endDay: index === 4 ? 90 : (index + 1) * 15,
    })),
  }
}
describe("单方案交付", () => {
  it("返回一个方案及未来日排期，不包含候选分类或历史运营甘特", () => {
    const result = buildSingleOperationPlanResult(JSON.stringify(output()), INPUT, "now")
    expect(result.schemaVersion).toBe(2)
    expect(result.operationPlan.tasks).toHaveLength(5)
    expect(result.operationPlan.tasks[4].endDate).toBe("2026-12-20")
    expect(result).not.toHaveProperty("plans")
    expect(result).not.toHaveProperty("recommendedPlanId")
    expect(result).not.toHaveProperty("historicalOperations")
    expect(result.operationPlan).not.toHaveProperty("planId")
  })
  it.each(["json", "multi", "phase", "range", "count", "summary"])(
    "拒绝不合格输出并提供纠错反馈：%s",
    kind => {
      const plan = output()
      if (kind === "phase") plan.tasks[2].phase = "opt"
      if (kind === "range") plan.tasks[0].endDay = 91
      if (kind === "count") plan.tasks = []
      if (kind === "summary") plan.summary = ""
      const value =
        kind === "json" ? "bad" : JSON.stringify(kind === "multi" ? { ...plan, plans: [] } : plan)
      expect(() => parseSingleOperationPlan(value, INPUT)).toThrow()
      expect(describeSinglePlanIssues(value, INPUT).length).toBeGreaterThan(0)
    }
  )
})
