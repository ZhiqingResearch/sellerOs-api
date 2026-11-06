import { History, ListingAiStep, ListingGenerationTask, Prisma } from "@prisma/client"
import { parseListingJsonObject } from "../listing/listing-result-parser"
import { prepareListingScoreDelivery } from "../listing/listing-score-delivery"
import { parseListingScoreSource } from "../listing/listing-score-evidence"
import { listingGenerationChargeId } from "../usage/fixed-module-credits"
import type { GenerationRecord } from "../usage/generation-record.service"
import { inputString, listingUserInput } from "./generation-user-input"

type HistorySource = Pick<
  History,
  "id" | "userId" | "type" | "title" | "data" | "version" | "createdAt"
>
type LogRow = {
  id: number
  credits: Prisma.Decimal | null
  requestId: string | null
  meta: Prisma.JsonValue | null
}

function object(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function savedResult(task: ListingGenerationTask, main: ListingAiStep) {
  const result = object(task.input).result
  if (result && typeof result === "object" && !Array.isArray(result)) return result
  try {
    return parseListingJsonObject(main.outputText ?? "") as Prisma.JsonObject
  } catch {
    return null
  }
}

function reportExists(value: Prisma.JsonValue): boolean {
  const report = object(value)
  if (report.result) return true
  if (Array.isArray(report.plans)) return report.plans.some(plan => !!object(plan).result)
  return Object.keys(report).some(key => key !== "params" && key !== "plans")
}

function record(
  history: HistorySource,
  suffix: string,
  operation: string,
  model: string | null,
  credits: Prisma.Decimal | null,
  occurredAt: Date,
  userInput = listingUserInput(history.data)
): GenerationRecord {
  return {
    key: `TEXT:${history.type}:${history.id}${suffix}`,
    function: history.type as "LISTING_GENERATION" | "LISTING_SCORING",
    id: history.id,
    userId: history.userId,
    username: "",
    phone: "",
    orgs: [],
    roles: [],
    prompt: userInput,
    model: model ?? "",
    modelLabel: model ?? "—",
    models: model ? [model] : [],
    operation,
    credits: credits?.toString() ?? null,
    status: "COMPLETED",
    resultUrl: null,
    expired: false,
    deleted: false,
    contentType: "TEXT",
    createdAt: occurredAt,
  }
}

function sumCredits(ids: number[], logs: LogRow[]): Prisma.Decimal | null {
  const selected = [...new Set(ids)].map(id => logs.find(log => log.id === id))
  if (!selected.length || selected.some(log => log?.credits == null)) return null
  return selected.reduce((sum, log) => sum.plus(log!.credits!), new Prisma.Decimal(0))
}

/** 每次已采纳的成功任务各留一条，附带自动评分不另造成功记录或重复计算费用。 */
export async function projectListingGenerationRecords(
  tx: Prisma.TransactionClient,
  history: HistorySource
): Promise<GenerationRecord[]> {
  if (history.type !== "LISTING_GENERATION" && history.type !== "LISTING_SCORING") return []
  const run = await tx.listingRun.findUnique({
    where: { historyId: history.id },
    include: { steps: true, generations: true },
  })
  const steps = run?.steps ?? []
  const tasks = run?.generations ?? []
  const requestIds = tasks.flatMap(task => {
    const input = object(task.input)
    const operation = object(input.main).operation
    if (operation !== "generation") return []
    const billingId =
      typeof input.generationBillingId === "string" ? input.generationBillingId : run!.runId
    return [listingGenerationChargeId(history.userId, billingId)]
  })
  const ids = steps.flatMap(step => (step.usageLogId == null ? [] : [step.usageLogId]))
  const logs = await tx.usageLog.findMany({
    where: {
      userId: history.userId,
      source: { in: ["listing.generate", "listing.score"] },
      OR: [
        { id: { in: ids } },
        { requestId: { in: requestIds } },
        { meta: { path: "$.listingHistoryId", equals: history.id } },
      ],
    },
    select: { id: true, credits: true, requestId: true, meta: true },
  })
  const records: GenerationRecord[] = []
  for (const task of tasks) {
    if (task.status !== "COMPLETED") continue
    const input = object(task.input)
    const operation = object(input.main).operation
    if (operation !== "generation" && operation !== "optimization") continue
    const main = steps.find(step => step.id === task.mainStepId)
    if (!main || main.status !== "COMPLETED" || !savedResult(task, main)) continue
    // 优化任务完成但未采纳时没有扣费，不应成为成功优化消费记录。
    if (operation === "optimization" && main.usageLogId == null) continue
    const scoreId = typeof input.autoScoreStepId === "number" ? input.autoScoreStepId : null
    const taskSteps = steps.filter(step =>
      [task.mainStepId, task.longTitleStepId, scoreId].includes(step.id)
    )
    const chargeIds = taskSteps.flatMap(step => (step.usageLogId == null ? [] : [step.usageLogId]))
    let credits = sumCredits(chargeIds, logs)
    if (!chargeIds.length && operation === "generation") {
      const billingId =
        typeof input.generationBillingId === "string" ? input.generationBillingId : run!.runId
      // A/B 复用已结算生成单的后续任务不重复分摊首次费用。
      if (logs.some(log => log.requestId === listingGenerationChargeId(history.userId, billingId)))
        credits = new Prisma.Decimal(0)
    }
    records.push(
      record(
        history,
        `:task:${task.id}`,
        operation,
        main.model,
        credits,
        task.updatedAt,
        typeof object(input.main).userPrompt === "string"
          ? inputString(object(input.main).userPrompt)
          : listingUserInput(input.context) || listingUserInput(history.data)
      )
    )
  }
  if (tasks.length) return records

  // 没有后台任务的旧客户端报告引用持久版本，避免后来编辑正文改变成功快照。
  const revisions = await tx.historyRevision.findMany({
    where: { historyId: history.id },
    select: { id: true, data: true, createdAt: true },
    orderBy: { version: "asc" },
  })
  const revision = revisions.find(value => reportExists(value.data))
  if (!revision || !reportExists(revision.data)) return []
  const main = steps.find(
    step => ["generation", "score"].includes(step.operation) && step.status === "COMPLETED"
  )
  const optimizationIds = steps
    .filter(step => step.operation === "optimization")
    .flatMap(step => (step.usageLogId == null ? [] : [step.usageLogId]))
  const original = logs.filter(
    log => object(log.meta).operation !== "optimization" && !optimizationIds.includes(log.id)
  )
  const originalModel = original
    .map(log => object(log.meta).model)
    .find((value): value is string => typeof value === "string" && value !== "fixed-module")
  records.push(
    record(
      history,
      `:revision:${revision.id}`,
      "",
      main?.model ?? originalModel ?? null,
      sumCredits(
        original.map(log => log.id),
        logs
      ),
      revision.createdAt,
      listingUserInput(revision.data)
    )
  )
  for (const step of steps) {
    if (
      step.operation !== "optimization" ||
      step.status !== "COMPLETED" ||
      step.usageLogId == null ||
      !step.outputText?.trim()
    )
      continue
    records.push(
      record(
        history,
        `:step:${step.id}`,
        "optimization",
        step.model,
        sumCredits([step.usageLogId], logs),
        step.updatedAt
      )
    )
  }
  return records
}

function publicStep(step: ListingAiStep) {
  return {
    operation: step.operation,
    model: step.model,
    status: step.status,
    outputText: step.outputText,
  }
}

/** 详情只读取该次任务已落存的产出和参数，绝不返回任务 input/billing 原始快照。 */
export async function readListingTaskResult(
  tx: Prisma.TransactionClient,
  historyId: number,
  taskId: number
) {
  const task = await tx.listingGenerationTask.findFirst({
    where: { id: taskId, status: "COMPLETED", listingRun: { historyId } },
    include: { listingRun: { include: { history: true } } },
  })
  if (!task) return null
  const input = object(task.input)
  const scoreId = typeof input.autoScoreStepId === "number" ? input.autoScoreStepId : null
  const steps = await tx.listingAiStep.findMany({
    where: {
      listingRunId: task.listingRunId,
      id: {
        in: [task.mainStepId, task.longTitleStepId, scoreId].filter(
          (id): id is number => id != null
        ),
      },
    },
    orderBy: { id: "asc" },
  })
  const main = steps.find(step => step.id === task.mainStepId)
  if (!main || (object(input.main).operation === "optimization" && main.usageLogId == null))
    return null
  const result = savedResult(task, main)
  if (!result) return null
  let scoreResult: Prisma.JsonObject | null = null
  try {
    const score = steps.find(step => step.id === scoreId)
    if (score?.outputText) {
      const market = object(object(input.context).params).market
      const prompt = object(input.autoScore).userPrompt
      const delivered = prepareListingScoreDelivery(
        score.outputText,
        typeof market === "string" ? market : undefined,
        {
          sourceFacts: parseListingScoreSource(typeof prompt === "string" ? prompt : ""),
        }
      )
      if (delivered) scoreResult = JSON.parse(delivered) as Prisma.JsonObject
    }
  } catch {
    /* 原始评分正文仍包含于下方 steps，不重新评分。 */
  }
  const plan = {
    planIndex: task.planIndex,
    result,
    ...(scoreResult ? { scoreResult, score: scoreResult.total } : {}),
  }
  return {
    userId: task.listingRun.history.userId,
    createdAt: task.updatedAt,
    content: {
      report: {
        params: object(input.context).params ?? {},
        plans: task.planIndex === 1 ? [null, plan] : [plan],
      },
      steps: steps.map(publicStep),
    },
  }
}

export async function readListingStepResult(
  tx: Prisma.TransactionClient,
  historyId: number,
  stepId: number
) {
  const step = await tx.listingAiStep.findFirst({
    where: {
      id: stepId,
      status: "COMPLETED",
      usageLogId: { not: null },
      operation: "optimization",
      listingRun: { historyId },
    },
    include: { listingRun: { include: { history: true } } },
  })
  if (!step?.outputText?.trim()) return null
  let report: Prisma.JsonValue = step.outputText
  try {
    report = parseListingJsonObject(step.outputText) as Prisma.JsonObject
  } catch {
    /* 保留原始正文。 */
  }
  return {
    userId: step.listingRun.history.userId,
    createdAt: step.updatedAt,
    content: { report, steps: [publicStep(step)] },
  }
}
