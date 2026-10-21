import { BadRequestException, HttpException, Injectable, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import type { CreationSource } from "../common/types/creation-source"
import { PrismaService } from "../prisma/prisma.service"
import { GenerateService, type GenerateUploadFile } from "./generate.service"
import { ImageToImageService } from "./image-to-image.service"
import { LOCAL_REDRAW_MODEL } from "./local-redraw.constants"
import { LocalRedrawForm } from "./local-redraw.dto"
import { sourceImageResolutionTier } from "./local-redraw"
import type { LocalRedrawPlan } from "./local-redraw.constants"
export { parseLocalRedrawForm } from "./local-redraw.dto"
export type LocalRedrawFiles = { main?: GenerateUploadFile[]; refs?: GenerateUploadFile[] }

@Injectable()
export class LocalRedrawService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generate: GenerateService,
    private readonly i2i: ImageToImageService
  ) {}

  async create(
    form: LocalRedrawForm,
    files: LocalRedrawFiles,
    userId: number,
    source: CreationSource
  ) {
    let projectId = form.projectId
    let urls = form.mainImageUrls ?? []
    let portrait: Parameters<GenerateService["create"]>[0]["portrait"]
    let resolutionTier: LocalRedrawPlan["resolutionTier"]
    if (form.sourceImageId) {
      const image = await this.prisma.generatedImage.findFirst({
        where: {
          id: form.sourceImageId,
          source,
          deletedAt: null,
          status: "SUCCESS",
          task: { userId, source, deletedAt: null, project: { userId, source, deletedAt: null } },
        },
        include: { task: { include: { project: true } } },
      })
      if (!image?.url) throw new NotFoundException("原图不存在或不可用")
      if (projectId !== undefined && projectId !== image.task.projectId)
        throw new BadRequestException("原图不属于指定项目")
      projectId = image.task.projectId
      resolutionTier = sourceImageResolutionTier(image.task)
      // 传 sourceImageId 时原图由服务器读取；URL/文件只能提供标注图及后续参考图。
      if (files.main?.length)
        throw new BadRequestException("传 sourceImageId 时不要重复上传 main 原图")
      urls = [image.url, ...urls]
      if (image.task.type === "PORTRAIT") {
        const config = image.task.promptConfig
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new BadRequestException("原人像任务缺少配置")
        portrait = {
          promptConfig: {
            ...config,
            localRedraw: { sourceImageId: image.id, provider: LOCAL_REDRAW_MODEL },
          } as Prisma.InputJsonObject,
          ...(image.task.viewConfig !== null
            ? { viewConfig: image.task.viewConfig as Prisma.InputJsonValue }
            : {}),
          presetOption: image.task.presetOption ?? undefined,
        }
      }
    }
    if (!form.sourceImageId && urls[0]) {
      // URL 输入也只继承当前用户、当前来源的生成记录，不能按外部 URL 冒用他人档位。
      const image = await this.prisma.generatedImage.findFirst({
        where: { url: urls[0], status: "SUCCESS", deletedAt: null, source,
          task: { userId, source, deletedAt: null, project: { userId, source, deletedAt: null } } },
        include: { task: true },
      })
      if (image) resolutionTier = sourceImageResolutionTier(image.task)
      else {
        const item = await this.prisma.imageGenItem.findFirst({
          where: { url: urls[0], status: "SUCCEEDED", deletedAt: null,
            job: { userId, source, businessType: "IMAGE_CREATIVE" } },
          include: { job: true },
        })
        if (item) {
          const request = item.job.request as Prisma.JsonObject | null
          resolutionTier = sourceImageResolutionTier({
            executionSpec: { form: request, localRedraw: request?.localRedraw },
          })
        }
      }
    }
    if (urls.length && files.main?.length)
      throw new BadRequestException("URL 原图和 main 文件不能同时传")
    if (urls.length + (files.main?.length ?? 0) + (files.refs?.length ?? 0) < 2)
      throw new BadRequestException("局部重绘必须提供原图和标注图")
    if (projectId) {
      const project = await this.prisma.imageProject.findFirst({
        where: { id: projectId, userId, source, deletedAt: null },
      })
      if (!project) throw new NotFoundException("项目不存在")
      if (project.status === "ARCHIVED") throw new BadRequestException("归档项目不能创建任务")
      if (project.type === "PORTRAIT" && !portrait)
        throw new BadRequestException("人像重绘必须传 sourceImageId")
      const result = await this.generate.create(
        {
          form: JSON.stringify({
            mode: "image-creation",
            editMode: "local-redraw",
            provider: LOCAL_REDRAW_MODEL,
            projectId: String(projectId),
            prompt: form.prompt,
            count: form.count ?? 1,
            mainImageUrls: urls,
          }),
          files: { main: files.main, attachedRefs: files.refs },
          portrait,
          localRedrawResolutionTier: resolutionTier,
        },
        userId,
        source
      )
      if (!result.ok) throw new HttpException(result.error, result.status)
      return {
        success: true,
        taskId: result.taskId,
        generatedImages: result.generatedImages,
        localRedraw: result.localRedraw,
      }
    }
    // 未归档改图沿用 job 保存方式，只在此适配 URL/文件输入，不另建项目或任务表。
    const references = [
      ...(await Promise.all(urls.map(url => this.download(url)))),
      ...(files.main ?? []),
      ...(files.refs ?? []),
    ]
    const result = await this.i2i.create(
      {
        form: JSON.stringify({
          mode: "normal",
          editMode: "local-redraw",
          provider: LOCAL_REDRAW_MODEL,
          prompt: form.prompt,
          count: form.count ?? 1,
        }),
        files: { main: references.slice(0, 1), refs: references.slice(1) },
        localRedrawResolutionTier: resolutionTier,
      },
      userId,
      source
    )
    if (!result.ok) throw new HttpException(result.error, result.status)
    return {
      jobId: result.jobId,
      taskId: result.taskId,
      traceId: result.traceId,
      total: result.total,
      items: result.items,
      localRedraw: result.localRedraw,
    }
  }

  private async download(url: string): Promise<GenerateUploadFile> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok || !response.body) throw new Error("图片读取失败")
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.length
          if (size > 50 * 1024 * 1024) throw new Error("图片超过 50MB")
          chunks.push(part.value)
        }
      } finally {
        await reader.cancel()
      }
      return {
        fieldname: "main",
        buffer: Buffer.concat(chunks),
        mimetype: response.headers.get("content-type") ?? "image/png",
        size,
      }
    } catch {
      throw new BadRequestException("局部重绘参考图读取失败或超过 50MB")
    }
  }
}
