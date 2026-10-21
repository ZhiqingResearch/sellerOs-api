import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import { randomUUID } from "crypto"
import type { SpacesService } from "./spaces.service"

export async function createCropUpload(spaces: SpacesService, userId: number, directory: string) {
  return spaces.generateUploadUrl({
    key: `${directory}/${userId}/${randomUUID()}.png`,
    contentType: "image/png",
    acl: "public-read",
    metadata: { "owner-id": String(userId) },
  })
}

/** 仅检查前端直传成品，不下载原图、不改写文件。 */
export async function inspectCropPng(
  spaces: SpacesService,
  userId: number,
  url: string,
  directory: string
) {
  const prefix = spaces.getPublicUrl(`${directory}/${userId}/`)
  if (!url.startsWith(prefix) || !/^[\da-f-]{36}\.png$/.test(url.slice(prefix.length))) {
    throw new BadRequestException("请使用本人裁剪直传接口返回的公开图片地址")
  }
  const fileKey = `${directory}/${userId}/${url.slice(prefix.length)}`
  let bytes: Buffer
  try {
    const metadata = await spaces.getObjectMetadata(fileKey)
    if (metadata.metadata?.["owner-id"] !== String(userId)) {
      throw new BadRequestException("裁剪图片不属于当前用户")
    }
    if (metadata.contentType?.split(";")[0].trim().toLowerCase() !== "image/png") {
      throw new BadRequestException("请上传裁剪后的 PNG 图片")
    }
    bytes = await spaces.downloadBuffer(fileKey, "bytes=0-32")
  } catch (error) {
    if (error instanceof BadRequestException) throw error
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
    if (status === 404 || status === 416) throw new BadRequestException("图片不存在或尚未上传完成")
    throw new ServiceUnavailableException("图片存储服务暂时不可用")
  }
  if (
    bytes.length !== 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new BadRequestException("请上传有效的裁剪 PNG 图片")
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height || width > 2147483647 || height > 2147483647) {
    throw new BadRequestException("图片尺寸无效")
  }
  return { fileKey, mime: "image/png", width, height }
}
