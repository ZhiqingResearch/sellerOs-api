import { Injectable, type ArgumentMetadata, type NestMiddleware } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { contentInputs } from "./content-inputs"
import type { ModerationInput, ModerationReceipt, ModerationResult } from "./moderation.types"

export interface FrozenModerationMedia {
  url: string
  type: ModerationInput["type"]
  documentType?: string
}

interface Binding {
  metadata: ArgumentMetadata
  value: Promise<unknown>
}
export interface ModerationScope {
  bindings: Binding[]
  userInputs: () => Promise<ModerationInput[]>
  checks: Map<string, Promise<ModerationResult>>
  submissions: Map<string, Promise<ModerationReceipt>>
  completed: Map<string, ModerationResult>
  aliases: Map<string, string>
  snapshots: Map<string, Promise<FrozenModerationMedia>>
  mediaByDigest: Map<string, Promise<FrozenModerationMedia>>
  digests: Set<string>
  objects: Map<string, string>
}

// 写请求的原始用户提示词覆盖下游生成的模板；GET轮询仍使用任务中保存的审核输入。
export async function requestContentInputs(
  inputs: ModerationInput[],
  storedTask = false
): Promise<ModerationInput[]> {
  const scope = moderationScope.getStore()
  if (!scope) return inputs
  const original = await scope.userInputs()
  const prompts = original.filter(input => input.type === "TEXT")
  if (storedTask && !prompts.length) return inputs
  return [...prompts, ...inputs.filter(input => input.type !== "TEXT")]
}

export const moderationScope = new AsyncLocalStorage<ModerationScope>()

export async function setStoredModerationPrompts(prompts: string[]): Promise<void> {
  const scope = moderationScope.getStore()
  if (!scope || (await scope.userInputs()).some(input => input.type === "TEXT")) return
  const inputs = contentInputs({ prompts }, "stored")
  scope.userInputs = () => Promise.resolve(inputs)
}

export function createModerationScope(
  userInputs: () => Promise<ModerationInput[]>
): ModerationScope {
  let original: Promise<ModerationInput[]> | undefined
  return {
    bindings: [],
    userInputs: () => (original ??= userInputs()),
    checks: new Map(),
    submissions: new Map(),
    completed: new Map(),
    aliases: new Map(),
    snapshots: new Map(),
    mediaByDigest: new Map(),
    digests: new Set(),
    objects: new Map(),
  }
}

export function registerModerationValidation(metadata: ArgumentMetadata, value: Promise<unknown>) {
  if (metadata.type === "body" || metadata.type === "query") {
    moderationScope.getStore()?.bindings.push({ metadata, value })
    // 另一参数先失败时，此校验仍由原管道抛出；避免暂未读取的Promise成为未处理拒绝。
    void value.catch(() => undefined)
  }
}

export function aliasModerationMedia(url: string, digest: string) {
  const scope = moderationScope.getStore()
  if (!scope) return
  scope.aliases.set(url, digest)
  const frozen = scope.mediaByDigest.get(digest)
  if (frozen) scope.snapshots.set(url, frozen)
}

export function registerModerationUpload(key: string, url: string, bytes: Uint8Array) {
  const scope = moderationScope.getStore()
  if (!scope?.digests.size) return
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (!scope.digests.has(digest)) return
  scope.objects.set(key, digest)
  aliasModerationMedia(url, digest)
}

@Injectable()
export class ModerationScopeMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction) {
    if (!["POST", "PUT", "PATCH"].includes(request.method)) return next()
    const scope = createModerationScope(async () => {
      const values = await Promise.all(
        scope.bindings.map(async binding => ({ ...binding, result: await binding.value }))
      )
      const input = (type: "body" | "query", fallback: unknown): unknown => {
        const matching = values.filter(binding => binding.metadata.type === type)
        const whole = matching.find(binding => !binding.metadata.data)
        return whole
          ? whole.result
          : matching.length
            ? Object.fromEntries(matching.map(binding => [binding.metadata.data!, binding.result]))
            : fallback
      }
      return contentInputs(
        { body: input("body", request.body as unknown), query: input("query", request.query) },
        "request"
      )
    })
    moderationScope.run(scope, next)
  }
}
