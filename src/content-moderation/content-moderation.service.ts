import {
  BadRequestException,
  HttpException,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { setTimeout } from "node:timers/promises"
import { AliyunContentModerationProvider } from "../common/providers/aliyun-content-moderation.provider"
import { SpacesService } from "../spaces/spaces.service"
import { contentInputs, mediaType } from "./content-inputs"
import { ContentSnapshotService, DOCUMENT_MIME_TYPES } from "./content-snapshot.service"
import type { ModerationInput, ModerationResult } from "./moderation.types"
import { recordReview } from "../aigc/text-audit"
import { aliasModerationMedia, moderationScope, requestContentInputs } from "./moderation-scope"

@Injectable()
export class ContentModerationService {
  constructor(
    private readonly provider: AliyunContentModerationProvider,
    private readonly spaces: SpacesService,
    private readonly snapshots: ContentSnapshotService
  ) {}

  async assertContent(
    value: unknown,
    key = "input",
    technicalFields: readonly string[] = []
  ): Promise<unknown> {
    const inputs = await requestContentInputs(contentInputs(value, key, technicalFields))
    if (!inputs.some(input => input.type !== "TEXT")) {
      await this.assertInputs(inputs)
      return value
    }
    const snapshot = await this.snapshots.freeze(value, key, technicalFields)
    await this.assertInputs(snapshot.inputs)
    return snapshot.value
  }

  async assertInputs(inputs: ModerationInput[]): Promise<void> {
    try { await this.assertInputsAudited(await requestContentInputs(inputs)); recordReview("PASSED") }
    catch (error) {
      recordReview(error instanceof BadRequestException && (error.getResponse() as { code?: string }).code === "MODERATION_REJECTED" ? "REJECTED" : "FAILED")
      throw error
    }
  }

  private async assertInputsAudited(inputs: ModerationInput[]): Promise<void> {
    // 普通无任务接口最多等待90秒；到期不执行原业务，由调用方重试。
    const deadline = Date.now() + 90_000
    for (const input of inputs) {
      if (Date.now() >= deadline) throw this.pending()
      let result: ModerationResult | null
      if (input.type === "TEXT" || input.type === "IMAGE") {
        result = await this.provider.check(input, Math.min(10_000, deadline - Date.now()))
      } else {
        const receipt = await this.provider.submit(
          input,
          randomUUID(),
          Math.min(10_000, deadline - Date.now())
        )
        result = null
        while (!result && Date.now() < deadline) {
          result = await this.provider.poll(
            input.type,
            receipt,
            Math.min(10_000, deadline - Date.now())
          )
          if (!result) await setTimeout(Math.min(3000, Math.max(0, deadline - Date.now())))
        }
        if (!result) throw this.pending()
      }
      const decision = this.provider.decide(result, this.provider.service(input.type))
      if (decision === "REJECTED") {
        throw new BadRequestException({
          code: "MODERATION_REJECTED",
          message: "输入内容未通过安全审核，请修改后重试",
        })
      }
      if (decision !== "PASSED") {
        throw new ServiceUnavailableException({
          code: "MODERATION_DECISION_UNDETERMINED",
          message: "内容审核未能明确判定，请稍后重试",
        })
      }
    }
  }

  async assertFile(file: {
    path?: string
    buffer?: Buffer
    mimetype?: string
    originalname?: string
  }): Promise<void> {
    if (!file.buffer && !file.path) throw new BadRequestException("无法读取待审核文件")
    const type = mediaType(`file ${file.mimetype || ""}`, file.originalname || "")
    if (!type) throw new BadRequestException("该文件类型暂不支持内容审核")
    const extension =
      file.originalname
        ?.split(".")
        .pop()
        ?.replace(/[^a-zA-Z0-9]/g, "") || "bin"
    const scope = moderationScope.getStore()
    const key = `content-moderation/${scope ? "snapshots" : "temporary"}/${randomUUID()}.${extension}`
    try {
      let digest: string | undefined
      if (scope) {
        const hash = createHash("sha256")
        if (file.buffer) hash.update(file.buffer)
        else for await (const chunk of createReadStream(file.path!)) hash.update(chunk as Buffer)
        digest = hash.digest("hex")
        scope.digests.add(digest)
      }
      if (file.buffer)
        await this.spaces.uploadBuffer(
          file.buffer,
          key,
          file.mimetype || "application/octet-stream",
          "private"
        )
      else
        await this.spaces.uploadFile(
          file.path!,
          key,
          file.mimetype || "application/octet-stream",
          "private"
        )
      const url = await this.spaces.generateSignedDownloadUrl(key, scope ? 24 * 3600 : 3600)
      const input: ModerationInput = {
        key: "file", type, url,
        ...(type === "DOCUMENT" ? { documentType: DOCUMENT_MIME_TYPES[(file.mimetype || "").split(";")[0].trim().toLowerCase()] || (extension === "md" ? "txt" : extension) } : {}),
      }
      if (scope && digest) {
        const frozen = Promise.resolve({ url, type, documentType: input.documentType })
        scope.mediaByDigest.set(digest, frozen)
        scope.objects.set(key, digest)
        aliasModerationMedia(url, digest)
      }
      await this.assertInputs([
        input,
      ])
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException({
        code: "MODERATION_FILE_UNAVAILABLE",
        message: "无法准备待审核文件，请稍后重试",
      })
    } finally {
      // 清理失败不将存储SDK原始错误（可能含签名地址）传播到请求日志。
      if (!scope) await this.spaces.deleteObject(key).catch(() => undefined)
    }
  }

  private pending() {
    return new RequestTimeoutException({
      code: "MODERATION_PENDING",
      message: "内容审核尚未完成，请稍后重试",
    })
  }
}
