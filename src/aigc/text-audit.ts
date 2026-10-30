import { HttpException } from "@nestjs/common"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { contentInputs } from "../content-moderation/content-inputs"

export type ReviewState = "NOT_CHECKED" | "PASSED" | "REJECTED" | "FAILED"
export interface TextAuditContext {
  requestId: string
  userId: () => number | null
  question: () => unknown
  review: ReviewState
  rejectionLogged?: boolean
  rejectedInput?: () => boolean
  displayName: (id: string) => Promise<string | null>
  write: (entry: Record<string, unknown>) => Promise<void>
}
export const textAuditContext = new AsyncLocalStorage<TextAuditContext>()
let backgroundContext: ((userId: number) => TextAuditContext) | undefined

export function setBackgroundAuditContext(factory: typeof backgroundContext) {
  backgroundContext = factory
}

export function withAigcUser<T>(userId: number, operation: () => T): T {
  const context = textAuditContext.getStore()
  const owned = context ? { ...context, userId: () => userId } : backgroundContext?.(userId)
  return owned ? textAuditContext.run(owned, operation) : operation()
}

function questions(value: unknown): string[] {
  return contentInputs(value, "question", ["phone", "email"])
    .filter(input => input.type === "TEXT" && input.content)
    .map(input => input.content!)
}

function reviewError(error: unknown): ReviewState | undefined {
  if (!(error instanceof HttpException)) return
  const response = error.getResponse() as { code?: string }
  if (response.code === "MODERATION_REJECTED") return "REJECTED"
  if (response.code?.startsWith("MODERATION_")) return "FAILED"
}

export function recordReview(state: ReviewState) {
  const context = textAuditContext.getStore()
  if (context) context.review = state
}

export function setAigcUserId(userId: number) {
  const context = textAuditContext.getStore()
  if (context) context.userId = () => userId
}

export async function logRejectedInput(error: unknown) {
  const context = textAuditContext.getStore()
  const review = reviewError(error)
  if (!context || !review || context.rejectionLogged || context.rejectedInput?.() === false) return
  context.rejectionLogged = true
  context.review = review
  await context.write({
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    userId: context.userId(),
    question: questions(context.question()),
    displayName: null,
    moderationStatus: review,
    generationStatus: "NOT_STARTED",
  })
}

async function begin(model: string, question: unknown) {
  const context = textAuditContext.getStore()
  if (!context) return () => Promise.resolve()
  const original = questions(context.question())
  const entry = {
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    callId: randomUUID(),
    userId: context.userId(),
    question: original.length ? original : questions(question),
    displayName: await context.displayName(model),
  }
  await context.write({ ...entry, moderationStatus: context.review, generationStatus: "STARTED" })
  return async (status: string, error?: unknown) => {
    const review = reviewError(error) ?? context.review
    await context.write({
      ...entry,
      completedAt: new Date().toISOString(),
      moderationStatus: review,
      generationStatus: reviewError(error) ? "NOT_STARTED" : status,
    })
  }
}

export async function auditText<T>(
  model: string,
  question: unknown,
  operation: () => Promise<T>
): Promise<T> {
  const parent = textAuditContext.getStore()
  return parent
    ? textAuditContext.run({ ...parent }, () => auditedText(model, question, operation))
    : auditedText(model, question, operation)
}

async function auditedText<T>(
  model: string,
  question: unknown,
  operation: () => Promise<T>
): Promise<T> {
  const finish = await begin(model, question)
  try {
    const result = await operation()
    await finish(result == null ? "FAILED" : "SUCCEEDED")
    return result
  } catch (error) {
    await finish("FAILED", error)
    throw error
  }
}

export async function* auditTextStream<T>(
  model: string,
  question: unknown,
  operation: () => AsyncGenerator<T>
): AsyncGenerator<T> {
  const parent = textAuditContext.getStore()
  const context = parent ? { ...parent } : undefined
  const run = <R>(operation: () => R): R =>
    context ? textAuditContext.run(context, operation) : operation()
  const finish = await run(() => begin(model, question))
  const iterator = run(operation)
  let status = "CANCELLED"
  let failure: unknown
  try {
    while (true) {
      const item = await run(() => iterator.next())
      if (item.done) {
        status = "SUCCEEDED"
        break
      }
      yield item.value
    }
  } catch (error) {
    status = "FAILED"
    failure = error
    throw error
  } finally {
    try {
      await run(() => iterator.return(undefined))
    } finally {
      await finish(status, failure)
    }
  }
}
