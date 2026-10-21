import { type ListingGenerationTask } from "@prisma/client"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiService } from "./listing-ai.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import { buildListingScoreSystemPrompt } from "./listing-score-prompt"

const body = '{"title":"Wireless Earbuds","description":"Clear sound","bullets":["Compact"]}'
const autoScore = { operation: "score" as const, userPrompt: "score earbuds" }
function fixture() {
  const task = {
    id: 1,
    attemptId: "attempt",
    listingRunId: 2,
    planIndex: 0,
    mainStepId: 3,
    status: "READY",
    isModelComplete: true,
    input: { context: { params: { keyword: "earbuds" } } },
    billing: {
      billing: {
        costCny: "1",
        currency: "CNY",
        model: "ZQ-Think-Flash",
        requestId: "request",
        requestIds: ["request"],
      },
    },
    listingRun: { id: 2, runId: "run", historyId: 4 },
  }
  const prisma = {
    listingGenerationTask: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(task),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    listingAiStep: {
      create: jest.fn().mockResolvedValue({ id: 9 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 3, outputText: body }),
      update: jest.fn().mockResolvedValue({}),
    },
    listingRun: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ history: { userId: 5 }, historyId: 4, runId: "run" }),
    },
  }
  const ai = { chargeSavedOutput: jest.fn().mockResolvedValue(88) }
  const runs = {
    update: jest.fn(
      async (
        _user: number,
        _run: string,
        _dto: unknown,
        callback: (tx: unknown) => Promise<void>
      ) => callback(prisma)
    ),
  }
  const gateway = { streamChat: jest.fn() }
  const service = new ListingGenerationService(
    prisma as unknown as PrismaService,
    gateway as unknown as AiGatewayProvider,
    ai as unknown as ListingAiService,
    runs as unknown as ListingRunService
  )
  return { task, prisma, ai, runs, gateway, service }
}

describe("Listing 后台任务与主生成结算", () => {
  it("描述失分但无扣分依据时自动生成正常完成，保留正文且不返回scoreError", async () => {
    const f = fixture()
    const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-negative-description-20261014.json"), "utf8"))
    const raw = JSON.parse(incident.primary)
    Object.assign(raw.dimensions[3].criteria[2], { score: 2, description: "描述结构合规，包含场景与规格。", deductions: [] })
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify(raw) })
    await f.service.finalizeScore({ ...f.task, status: "SCORE_READY", input: {
      context: { params: { market: "amazon_us" } }, result: JSON.parse(body), autoScoreStepId: 9,
      autoScore: { userPrompt: `<listing-scoring-source>${JSON.stringify(incident.sourceFacts)}</listing-scoring-source>` },
    }, billing: { ...f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask)
    const update = f.runs.update.mock.calls[0][2] as any
    expect(update).toMatchObject({ status: "COMPLETED", error: undefined, data: { plans: [{ result: JSON.parse(body), score: null }] } })
    expect(update.data.plans[0].scoreError).toBeUndefined()
    expect(update.data.plans[0].scoreResult.dimensions[3].criteria[2]).toMatchObject({ score: null, status: "PENDING", deductions: [] })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("实跑负分报告正常展示正文和2分描述评分，不产生页面scoreError", async () => {
    const f = fixture()
    const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-negative-description-20261014.json"), "utf8"))
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: incident.primary })
    await f.service.finalizeScore({ ...f.task, status: "SCORE_READY", input: {
      context: { params: { market: "amazon_us" } }, result: JSON.parse(body), autoScoreStepId: 9,
      autoScore: { userPrompt: `<listing-scoring-source>${JSON.stringify(incident.sourceFacts)}</listing-scoring-source>` },
    }, billing: { ...f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask)
    const update = f.runs.update.mock.calls[0][2] as any
    expect(update).toMatchObject({ status: "COMPLETED", stage: "completed", error: undefined })
    expect(update.data.plans[0]).toMatchObject({ result: JSON.parse(body), score: 95.5 })
    expect(update.data.plans[0].scoreError).toBeUndefined()
    expect(update.data.plans[0].scoreResult.dimensions[3].criteria[2].score).toBe(2)
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("自动评分推荐属性未填误扣6分时正常交付30分，不报错或重新调用模型", async () => {
    const f = fixture()
    const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-summary-28-20260917.json"), "utf8"))
    const score = JSON.parse(incident.primary)
    Object.assign(score.dimensions[0].criteria[0], { score: 24, status: "VERIFIED", deductions: [
      { points: 6, reason: "属性填写完整度与重要度加权扣分", ruleId: "attribute.required", evidence: "前台可见属性13项，部分推荐属性未填，按权重折算" },
    ] })
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify(score) })
    await f.service.finalizeScore({ ...f.task, status: "SCORE_READY", input: { ...f.task.input, result: JSON.parse(body), autoScoreStepId: 9 }, billing: { ...f.task.billing, score: f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "COMPLETED", stage: "completed", data: { plans: [{ result: JSON.parse(body), scoreResult: { dimensions: [
      { criteria: [expect.objectContaining({ score: 30, status: "VERIFIED", deductions: [] }), ...score.dimensions[0].criteria.slice(1)] },
      score.dimensions[1], score.dimensions[2], score.dimensions[3],
    ] } }] } })
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("自动评分与独立打分共用完整系统提示词，评分温度固定为0", async () => {
    const f = fixture()
    const autoScore = { operation: "score", systemPrompt: "平台评分规则", userPrompt: "商品原文", temperature: 0.8 }
    const consume = jest.spyOn(f.service, "consume").mockResolvedValue(f.task.billing)
    await f.service.executeScore({ ...f.task, input: { ...f.task.input, autoScore, autoScoreStepId: 9 } } as unknown as ListingGenerationTask)
    expect(consume).toHaveBeenCalledWith(9, {
      ...autoScore, temperature: 0,
      systemPrompt: buildListingScoreSystemPrompt(autoScore.systemPrompt, autoScore.userPrompt),
    })
    expect(consume.mock.calls[0][1].systemPrompt).toContain("不得用负分")
  })

  it("旧格式自动评分负分无依据时正常保留正文，暂不出分且不结算", async () => {
    const f = fixture()
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify({
      total: 80, potential: "A", suggestions: [],
      dimensions: [{ name: "质量", score: 80, maxScore: 100, criteria: [{ name: "描述", score: -4, maxScore: 3 }] }],
    }) })
    await f.service.finalizeScore({ ...f.task, status: "SCORE_READY", input: { ...f.task.input, result: JSON.parse(body), autoScoreStepId: 9 }, billing: { ...f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "COMPLETED", error: undefined, data: { plans: [{ score: null }] } })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("完整CDQ报告有取证差异时仍交付自动评分，按原细则汇总且只结算主生成", async () => {
    const f = fixture()
    const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-summary-28-20260917.json"), "utf8"))
    const original = JSON.parse(incident.primary)
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: incident.primary })
    const task = {
      ...f.task, status: "SCORE_READY",
      input: {
        context: { params: { market: "amazon_us" } }, result: JSON.parse(body), autoScoreStepId: 9,
        autoScore: { operation: "score", userPrompt: "mode：standard\n<listing-scoring-source>" + JSON.stringify(incident.sourceFacts) + "</listing-scoring-source>" },
        generationBillingId: "shared-generation",
      },
      billing: { ...f.task.billing, score: f.task.billing, isScoreComplete: true },
    } as unknown as ListingGenerationTask
    await f.service.finalizeScore(task)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({
      status: "COMPLETED", stage: "completed",
      data: { plans: [{
        result: JSON.parse(body), score: 84.4286,
        scoreResult: { validationStatus: "BEST_EFFORT", dimensions: [
          { criteria: original.dimensions[0].criteria }, original.dimensions[1], original.dimensions[2],
          { score: 13 },
        ] },
      }] },
    })
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledWith(
      5, "generation", f.task.billing.billing, undefined, f.prisma, 4, 3, "run", "shared-generation",
    )
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
    expect(f.prisma.listingAiStep.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outputText: expect.any(String) }),
    }))
  })
  it("CDQ报告缺少评分细则仍正常展示正文和已有评分，缺项暂不出分且不结算", async () => {
    const f = fixture()
    const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-summary-28-20260917.json"), "utf8"))
    const score = JSON.parse(incident.primary)
    score.dimensions[0].criteria.pop()
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify(score) })
    const task = {
      ...f.task, status: "SCORE_READY",
      input: { context: { params: { market: "amazon_us" } }, result: JSON.parse(body), autoScoreStepId: 9 },
      billing: { ...f.task.billing, score: f.task.billing, isScoreComplete: true },
    } as unknown as ListingGenerationTask
    await f.service.finalizeScore(task)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({
      status: "COMPLETED", stage: "completed", error: undefined,
      data: { plans: [{ result: JSON.parse(body), score: null, scoreResult: { recoveryNotice: expect.any(String) } }] },
    })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("正文完成原子创建自动评分队列，不提前标记整次生成成功", async () => {
    const f = fixture()
    const autoScore = { operation: "score" as const, userPrompt: "score earbuds" }
    const result = await f.service.finish(5, "attempt", { status: "COMPLETED", result: JSON.parse(body), autoScore })
    expect(result.status).toBe("SCORE_QUEUED")
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "RUNNING", stage: "auto_score" })
    expect(f.prisma.listingGenerationTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { input: expect.objectContaining({ autoScoreStepId: 9, autoScore, result: JSON.parse(body) }) },
    }))
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it.each(["SCORE_QUEUED", "SCORING", "SCORE_READY"])("重复完成 %s 不创建评分或重复扣费", async status => {
    const f = fixture()
    f.task.status = status
    await f.service.finish(5, "attempt", { status: "COMPLETED", result: JSON.parse(body), autoScore })
    expect(f.prisma.listingAiStep.create).not.toHaveBeenCalled()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("自动评分响应与账单保存后再提交报告；恢复只入库不重复调用模型", async () => {
    const f = fixture()
    const score = { total: 80, potential: "A", suggestions: [], dimensions: [{ name: "质量", score: 80, maxScore: 100, criteria: [] }] }
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify(score) })
    const task = { ...f.task, status: "SCORE_READY", input: { ...f.task.input, result: JSON.parse(body), autoScoreStepId: 9 }, billing: { ...f.task.billing, score: f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask
    await f.service.finalizeScore(task)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "COMPLETED", data: { plans: [{ scoreResult: score, score: 80, result: JSON.parse(body) }] } })
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledWith(5, "generation", f.task.billing.billing, undefined, f.prisma, 4, 3, "run", "run")
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it.each([
    { isUnavailable: false, hasMissingLimits: false },
    { isUnavailable: true, hasMissingLimits: false },
    { isUnavailable: true, hasMissingLimits: true },
  ])("新版CDQ自动评分支持未获取和空满分 %j", async ({ isUnavailable, hasMissingLimits }) => {
    const f = fixture()
    const score = {
      scoreVersion: "cdq-2026-09-16", total: isUnavailable ? null : 100, potential: "评分结果", suggestions: ["建议补充证据"],
      dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
        name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][index],
        maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
        criteria: limits.map((maxScore, criterionIndex) => ({
          name: index === 0 ? ["结构化属性", "标题质量", "变体质量", "图片质量", "A+ 内容", "五点描述"][criterionIndex] : `项目${criterionIndex}`,
          score: index === 0 && isUnavailable ? null : maxScore,
          maxScore: index === 0 && hasMissingLimits ? null : maxScore,
          status: index === 0 && isUnavailable ? "UNAVAILABLE" : "VERIFIED", description: "取证状态说明", deductions: [],
        })),
      })),
    }
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify(score) })
    const task = { ...f.task, status: "SCORE_READY", input: { context: { params: { market: "amazon_us" } }, result: JSON.parse(body), autoScoreStepId: 9 }, billing: { ...f.task.billing, score: f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask
    await f.service.finalizeScore(task)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "COMPLETED", data: { plans: [{ score: isUnavailable ? null : 100, scoreResult: { scoreVersion: "cdq-2026-09-16" } }] } })
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(isUnavailable ? 0 : 1)
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
    if (hasMissingLimits) {
      const delivered = (f.runs.update.mock.calls[0][2] as { data: { plans: Array<{ scoreResult: typeof score }> } }).data.plans[0].scoreResult
      expect(delivered.dimensions[0].criteria.map(criterion => criterion.maxScore)).toEqual([30, 25, 20, 15, 5, 5])
      expect(delivered.dimensions[0].criteria.every(criterion => criterion.score === null && criterion.status === "UNAVAILABLE")).toBe(true)
    }
  })
  it("评分失败保留正文，标记部分完成，不伪造分数或扣评分积分", async () => {
    const f = fixture()
    const task = { ...f.task, status: "SCORE_READY", input: { ...f.task.input, result: JSON.parse(body), autoScoreStepId: 9 }, billing: { ...f.task.billing, isScoreComplete: false } } as unknown as ListingGenerationTask
    await f.service.finalizeScore(task)
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "PARTIAL", stage: "auto_score_failed", data: { plans: [{ result: JSON.parse(body), scoreError: expect.any(String) }] } })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("主生成正文保存不扣费，等待自动评分成功统一结算", async () => {
    const f = fixture()
    await f.service.finish(5, "attempt", { status: "COMPLETED", result: JSON.parse(body), autoScore })
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({
      data: { plans: [{ result: { title: "Wireless Earbuds" } }] },
    })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.prisma.listingAiStep.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { status: "COMPLETED", error: null, usageLogId: null },
    })
  })
  it("缺少自动评分配置不能把整次生成标为完成或扣主生成费用", async () => {
    const f = fixture()
    await expect(f.service.finish(5, "attempt", { status: "COMPLETED", result: JSON.parse(body) })).rejects.toThrow("必须包含自动评分")
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it.each(["PARTIAL", "FAILED"] as const)("%s 留存正文、不扣主生成积分", async status => {
    const f = fixture()
    await f.service.finish(5, "attempt", { status, error: "内容不完整" })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({
      status,
      data: { plans: [{ partialText: body }] },
    })
  })
  it("重复完成只返回原状态，不再次扣费", async () => {
    const f = fixture()
    f.task.status = "COMPLETED"
    await f.service.finish(5, "attempt", { status: "COMPLETED", result: JSON.parse(body) })
    expect(f.runs.update).not.toHaveBeenCalled()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("其他用户查不到任务，不调用扣费", async () => {
    const f = fixture()
    f.prisma.listingGenerationTask.findFirst.mockResolvedValue(null)
    await expect(f.service.finish(9, "attempt", { status: "FAILED" })).rejects.toThrow("不存在")
    expect(f.prisma.listingGenerationTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attemptId: "attempt", listingRun: { history: { userId: 9 } } },
      })
    )
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("响应未完整结束不能提交成功，不能用修补 JSON 冒充完整报告", async () => {
    const f = fixture()
    f.task.isModelComplete = false
    await expect(
      f.service.finish(5, "attempt", { status: "COMPLETED", result: JSON.parse(body), autoScore })
    ).rejects.toThrow("未完整结束")
    expect(f.runs.update).not.toHaveBeenCalled()
  })
  it("扣费事务异常向外抛出，不改为解析失败，也不调用 AI", async () => {
    const f = fixture()
    f.ai.chargeSavedOutput.mockRejectedValue(new Error("transaction failure"))
    const score = { total: 80, potential: "ok", suggestions: [], dimensions: [{ name: "quality", score: 80, maxScore: 100, criteria: [] }] }
    f.prisma.listingAiStep.findUniqueOrThrow.mockResolvedValue({ id: 9, outputText: JSON.stringify(score) })
    const task = { ...f.task, status: "SCORE_READY", input: { ...f.task.input, result: JSON.parse(body), autoScoreStepId: 9 }, billing: { ...f.task.billing, score: f.task.billing, isScoreComplete: true } } as unknown as ListingGenerationTask
    await expect(f.service.finalizeScore(task)).rejects.toThrow("transaction failure")
    expect(f.prisma.listingAiStep.update).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("断流保留已收到的正文，网关只调用一次", async () => {
    const f = fixture()
    f.gateway.streamChat.mockImplementation(async function* () {
      yield { type: "text", content: '{"title":"Earbuds"' }
      throw new Error("connection lost")
    })
    await expect(
      f.service.consume(3, { operation: "generation", userPrompt: "product" })
    ).rejects.toThrow("connection lost")
    expect(f.gateway.streamChat).toHaveBeenCalledTimes(1)
    expect(f.prisma.listingAiStep.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outputText: '{"title":"Earbuds"' }),
      })
    )
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("过期任务只转到响应恢复，不重新排队或请求模型", async () => {
    const f = fixture()
    f.prisma.listingGenerationTask.findFirst.mockResolvedValue(null)
    f.prisma.listingGenerationTask.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ id: 1, longTitleStepId: null }])
    await f.service.poll()
    expect(f.prisma.listingGenerationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, status: "RUNNING", leaseUntil: { lt: expect.any(Date) } },
        data: expect.objectContaining({ status: "READY" }),
      })
    )
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("完成模型调用只保存响应和账单，不提前扣主生成积分", async () => {
    const f = fixture()
    f.gateway.streamChat.mockImplementation(async function* () {
      yield { type: "text", content: body }
      yield { type: "billing", billing: f.task.billing.billing, content: "" }
    })
    await f.service.execute({
      ...f.task,
      input: { main: { operation: "generation", userPrompt: "earbuds" } },
    } as unknown as ListingGenerationTask)
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.prisma.listingGenerationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isModelComplete: true }) })
    )
    expect(f.prisma.listingGenerationTask.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: "READY", leaseUntil: null } })
    )
  })
})
