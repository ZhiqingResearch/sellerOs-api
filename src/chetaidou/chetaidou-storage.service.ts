// 车泰斗素材工作台 — 图片字节校验、私有上传、产物转存与签名
// F03/T05：非法文件不进入模型——真实字节类型校验（magic number + sharp 解码）
// 母版与模型产物 private；前端裁剪成品直传 public-read。
import {
  BadRequestException,
  Injectable,
  Logger,
} from "@nestjs/common"
import sharp from "sharp"
import { labelImage } from "../aigc/image-label"
import { retryDelivery } from "../aigc/aigc-metadata"
import { objectAigcMetadata } from "../aigc/media-delivery"
import { createCropUpload, inspectCropPng } from "../spaces/crop-upload"
import { SpacesService } from "../spaces/spaces.service"
import { CHETAIDOU_ERROR_CODES } from "./chetaidou.constants"

export interface ValidatedImageAsset {
  buffer: Buffer
  mime: string
  width: number
  height: number
  checksum: string
}

export type OriginalImageAsset = {
  callId: string
  fileKey: string
  mime: string
  width: number
  height: number
}

export function originalImageOf(metadata: unknown): OriginalImageAsset | null {
  const original = (metadata as { original?: OriginalImageAsset } | null)?.original
  return original && typeof original.fileKey === "string" && original.fileKey ? original : null
}

// 常见图片格式 magic number（JPEG/PNG/WebP）
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
    return "image/png"
  // WebP: RIFF....WEBP
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP")
    return "image/webp"
  return null
}

@Injectable()
export class ChetaidouStorageService {
  private readonly logger = new Logger(ChetaidouStorageService.name)
  constructor(private readonly spaces: SpacesService) {}

  async createCropUpload(userId: number) {
    return createCropUpload(this.spaces, userId, "chetaidou/crops")
  }

  /** 仅检查前端直传成品，不下载原图、不改写文件。 */
  async inspectCropPng(userId: number, url: string) {
    return inspectCropPng(this.spaces, userId, url, "chetaidou/crops")
  }

  /** 校验真实格式、尺寸与页数，拒绝动画/多页及损坏文件。 */
  async validateImage(buffer: Buffer): Promise<ValidatedImageAsset> {
    if (buffer.length === 0) {
      throw new BadRequestException({
        message: "上传文件为空",
        code: CHETAIDOU_ERROR_CODES.FILE_UNSUPPORTED,
      })
    }
    const sniffed = sniffImageMime(buffer)
    if (!sniffed) {
      throw new BadRequestException({
        message: "仅支持 JPEG/PNG/WebP 图片",
        code: CHETAIDOU_ERROR_CODES.FILE_UNSUPPORTED,
      })
    }
    let image: sharp.Sharp
    try {
      image = sharp(buffer, { failOn: "error", limitInputPixels: false })
    } catch {
      throw new BadRequestException({
        message: "图片解码失败",
        code: CHETAIDOU_ERROR_CODES.FILE_UNSUPPORTED,
      })
    }
    const meta = await image.metadata()
    if (!meta.format || !meta.width || !meta.height) {
      throw new BadRequestException({
        message: "无法读取图片尺寸，文件可能已损坏",
        code: CHETAIDOU_ERROR_CODES.FILE_UNSUPPORTED,
      })
    }
    if ((meta.pages ?? 1) > 1) {
      throw new BadRequestException({
        message: "不支持动画或多页图片",
        code: CHETAIDOU_ERROR_CODES.FILE_UNSUPPORTED,
      })
    }
    const fmt = String(meta.format ?? "")
    const actualMime = `image/${fmt === "jpg" ? "jpeg" : fmt}`
    if (actualMime !== sniffed) {
      throw new BadRequestException({
        message: "文件内容与扩展类型不符",
        code: CHETAIDOU_ERROR_CODES.FILE_UNSUPPORTED,
      })
    }
    return {
      buffer,
      mime: actualMime,
      width: meta.width,
      height: meta.height,
      checksum: sha256Hex(buffer),
    }
  }

  /** 私有上传母版/用户图；key 形如 chetaidou/<skuId>/<preset|u<ownerId>>/<imageId>/master.<ext> */
  async uploadMaster(asset: ValidatedImageAsset, key: string): Promise<string | null> {
    await this.spaces.uploadBuffer(asset.buffer, key, asset.mime, "private")
    try {
      return await this.uploadThumbnail(asset.buffer, key)
    } catch (error) {
      this.logger.warn(
        `缩略图生成失败，使用原图：${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  async uploadThumbnail(buffer: Buffer, masterKey: string): Promise<string> {
    const key = `${masterKey}.thumbnail.webp`
    const thumbnail = await sharp(buffer, { limitInputPixels: false })
      .rotate()
      .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
    await this.spaces.uploadBuffer(thumbnail, key, "image/webp", "private")
    return key
  }

  async thumbnailUrl(metadata: unknown, fallback: string | null): Promise<string | null> {
    const key = (metadata as { thumbnailKey?: string } | null)?.thumbnailKey
    return key ? this.signDownload(key, 3600).catch(() => fallback) : fallback
  }

  /** 生图产物转存（同 callId 固定 key，失败可重试同产物） */
  async hostArtifact(buffer: Buffer, key: string, mime: string): Promise<void> {
    const result = await retryDelivery(() => labelImage(buffer, key))
    await this.spaces.uploadBuffer(result.buffer, key, mime, "private", objectAigcMetadata(result.metadata))
  }

  /** 预览/下载短时效签名（5 分钟） */
  async signDownload(fileKey: string, expiresIn = 300, filename?: string): Promise<string> {
    return this.spaces.generateSignedDownloadUrl(fileKey, expiresIn, filename)
  }

  /** 给模型的源图签名（TTL 覆盖排队/取图/任务期限，建议 2 小时） */
  async signForModel(fileKey: string): Promise<string> {
    return this.spaces.generateSignedDownloadUrl(fileKey, 2 * 60 * 60)
  }

  masterFileKey(skuId: number, scope: string, imageRef: string): string {
    const ext = "png" // 统一存原始字节，key 扩展仅示意
    return `chetaidou/${skuId}/${scope}/${imageRef}/master.${ext}`
  }

  artifactFileKey(
    callId: string,
    extension = "png",
    variant: "output" | "original" = "output"
  ): string {
    return `chetaidou/generations/${callId}/${variant}.${extension}`
  }

  /** 下载命名：{sku}_{母版编号}_{taskShortId}_{index}.{ext} */
  downloadFilename(parts: {
    skuCode: string
    imageNumber?: string | null
    taskId: string
    index: number
    mime: string
  }): string {
    const ext = parts.mime.includes("png") ? "png" : parts.mime.includes("webp") ? "webp" : "jpg"
    const rawNumber = parts.imageNumber?.trim()
    const number = rawNumber ? `NO${rawNumber.replace(/^NO/i, "")}` : "master"
    return `${parts.skuCode}_${number}_${parts.taskId.slice(0, 8)}_${parts.index}.${ext}`
  }

  /** 删除未被引用的孤儿对象（上传落库失败的补偿） */
  async deleteObject(key: string): Promise<void> {
    await this.spaces.deleteObject(key)
  }
}

import { createHash } from "crypto"

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

/** 标准化 JSON SHA-256（requestHash/contextHash 用：对象键排序） */
export function stableHash(value: unknown): string {
  return sha256Hex(JSON.stringify(sortDeep(value)))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key])
    return out
  }
  return value
}
