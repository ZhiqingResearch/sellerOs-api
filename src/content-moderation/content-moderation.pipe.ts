import {
  BadRequestException,
  Inject,
  Injectable,
  Scope,
  ValidationPipe,
  type ArgumentMetadata,
} from "@nestjs/common"
import { REQUEST } from "@nestjs/core"
import type { Request } from "express"
import { rm } from "node:fs/promises"
import { contentInputs } from "./content-inputs"
import { ContentModerationService } from "./content-moderation.service"

// 供应商回执不属于用户输入，不可因正文审核阻塞入账或异步回调。
const CALLBACKS = [
  "/webhooks/ai-gateway",
  "/billing/webhooks/",
  "/customer/webhook/",
  "/product-publish/internal/rpa/results",
  "/rpa-creation/internal/tasks/",
]

@Injectable({ scope: Scope.REQUEST })
export class ContentModerationPipe extends ValidationPipe {
  constructor(
    @Inject(REQUEST) private readonly request: Request,
    private readonly moderation: ContentModerationService
  ) {
    super({ whitelist: true, transform: true })
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const path = this.request.path.replace(/^\/api(?=\/)/, "")
    if (
      path === "/content-moderation/check" &&
      metadata.type === "body" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).some(key => !["businessType", "businessTaskId"].includes(key))
    ) {
      throw new BadRequestException("审核接口只接受业务类型和业务任务ID")
    }
    const validated: unknown = await super.transform(value, metadata)
    if (
      metadata.type === "body" &&
      this.request.method === "POST" &&
      /^\/customer\/\d+\/voice$/.test(path)
    ) {
      throw new BadRequestException({
        code: "MODERATION_UNSUPPORTED_MEDIA",
        message: "本期暂不支持独立音频审核，音色克隆暂不能执行",
      })
    }
    if (CALLBACKS.some(prefix => path.startsWith(prefix))) return validated
    // 这两个入口在服务层冻结参数并复用VideoTask保存异步审核，不能先阻塞在HTTP层。
    const deferred =
      this.request.method === "POST" &&
      (/^\/video-project\/\d+\/(?:task|motion-control\/batch)$/.test(path) ||
        path === "/internal/generation/video-tasks")
    if (deferred) {
      if (metadata.type === "body") {
        // 完整生成参数由任务审核；批次素材名称等仅用于本地展示的文字也必须审核。
        const metadataContent = Object.fromEntries(
          Object.entries(validated as Record<string, unknown>).filter(
            ([key]) => !["params", "request", "category", "prompt"].includes(key)
          )
        )
        await this.moderation.assertInputs(
          contentInputs(
            metadataContent,
            "metadata",
            path.startsWith("/internal/generation/") ? ["phone", "category"] : []
          ).filter(input => input.type === "TEXT")
        )
      }
      return validated
    }
    if (metadata.type === "body" || metadata.type === "query") {
      if (
        /^\/(?:auth|internal\/(?:generation|llm-toolbox|credits)|open\/(?:credit|keyb\/credit))(?:\/|$)/.test(
          path
        ) ||
        (path === "/image-generation/local-redraw" &&
          this.request.headers?.["x-internal-token"] !== undefined)
      ) {
        await this.moderation.assertContent(validated, metadata.data || metadata.type, [
          "phone",
          "email",
        ])
        return validated
      }
      await this.moderation.assertContent(validated, metadata.data || metadata.type)
      // CRUD仍保存原素材地址；模型Provider另行冻结实际发送内容，避免把短期签名地址存入业务资料。
      return validated
    } else if (metadata.type === "custom" && validated && typeof validated === "object") {
      const inspect = async (candidate: unknown): Promise<void> => {
        if (!candidate || typeof candidate !== "object") return
        const file = candidate as { buffer?: Buffer; mimetype?: string; originalname?: string }
        if (Buffer.isBuffer(file.buffer)) await this.moderation.assertFile(file)
        else if (typeof (candidate as { path?: unknown }).path === "string") {
          const requestFiles = this.request as Request & { file?: unknown; files?: unknown }
          const uploads = Array.isArray(requestFiles.files)
            ? requestFiles.files
            : requestFiles.files && typeof requestFiles.files === "object"
              ? Object.values(requestFiles.files).flat()
              : []
          if (candidate === requestFiles.file || uploads.includes(candidate)) {
            try {
              await this.moderation.assertFile(
                candidate as { path: string; mimetype?: string; originalname?: string }
              )
            } catch (error) {
              await rm((candidate as { path: string }).path, { force: true }).catch(() => undefined)
              throw error
            }
          }
        } else if (Array.isArray(candidate)) for (const item of candidate) await inspect(item)
        else if (
          Object.getPrototypeOf(candidate) === Object.prototype ||
          Object.getPrototypeOf(candidate) === null
        ) {
          for (const item of Object.values(candidate)) await inspect(item)
        }
      }
      await inspect(validated)
    }
    return validated
  }
}
