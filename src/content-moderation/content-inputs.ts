import { BadRequestException } from "@nestjs/common"
import { getMetadataStorage } from "class-validator"
import { record, type ModerationInput, type ModerationMediaType } from "./moderation.types"

// 文本仅审核用户提示词；其余字段仍递归查找图片、视频和文档。
const PROMPT_FIELD =
  /^(?:.*prompt(?:override)?s?|instructions?|questions?|query|userContent|text)$/i
const TECHNICAL =
  /^(?:id|ids|.*Ids?|.*_ids?|keyA|keyB|code|.*Code|.*_code|otp|captcha|hash|.*Hash|.*_hash|salt|page|pageSize|limit|offset|sort|sortBy|orderBy|direction|status|publicId|model|modelName|modelPublicId|modelCategory|sourceType|requestId|request_id|idempotencyKey|attemptId|chargeRequestId|currency|locale|language|region|mimeType|mimetype|contentType|filename|originalname|prefix|callback|callbackUrl|callback_url|returnUrl|return_url|webhookUrl|webhook_url|resolution|aspectRatio|aspect_ratio|ratio|format|quality|size|seed|duration|durationSec|duration_seconds|startDate|endDate|createdAt|updatedAt|expiresAt)$/
const SENSITIVE_TECHNICAL =
  /password|token|secret|credential|signature|authorization|api[_-]?key|access[_-]?key/i
const STRUCTURED_FIELDS = new Set([
  "form",
  "payload",
  "params",
  "request",
  "settings",
  "configuration",
])

export function mediaType(
  key: string,
  value: string,
  parent: Record<string, unknown> = {}
): ModerationMediaType | null {
  const pathname = value.split(/[?#]/)[0].toLowerCase()
  if (/\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic)$/.test(pathname)) return "IMAGE"
  if (/\.(?:mp4|mov|webm|avi|mkv|m4v)$/.test(pathname)) return "VIDEO"
  if (/\.(?:pdf|docx?|pptx?|ppsx?|xlsx?|xlsm|xltx|xltm|txt|csv|html|md)$/.test(pathname))
    return "DOCUMENT"
  const hints = [
    key.split(/\s+/).at(-1),
    parent.mimeType,
    parent.mimetype,
    parent.type,
    ...key.split(/\s+/)[0].split(".").reverse(),
  ]
  for (const candidate of hints) {
    const hint = typeof candidate === "string" ? candidate.toLowerCase() : ""
    if (/image|frame|photo|picture|avatar|cover|thumbnail|图片/.test(hint)) return "IMAGE"
    if (/video|视频/.test(hint)) return "VIDEO"
    if (/audio|voice/.test(hint) || /\.(?:mp3|wav|aac|m4a|ogg|flac)$/.test(pathname)) {
      throw new BadRequestException({
        code: "MODERATION_UNSUPPORTED_MEDIA",
        message: "独立音频尚不支持内容审核，请移除音频素材",
      })
    }
    if (/document|file|attachment|文档/.test(hint)) return "DOCUMENT"
  }
  return null
}

export function contentInputs(
  value: unknown,
  root = "input",
  technicalFields: readonly string[] = []
): ModerationInput[] {
  const inputs: ModerationInput[] = []
  const prompts = new Set<string>()
  const visit = (item: unknown, path: string, name: string, parent: Record<string, unknown>) => {
    if (TECHNICAL.test(name) || SENSITIVE_TECHNICAL.test(name) || technicalFields.includes(name))
      return
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}.${index}`, name, parent))
      return
    }
    if (item !== null && typeof item === "object") {
      const object = record(item)
      const enumFields = new Set(
        typeof item.constructor === "function"
          ? getMetadataStorage()
              .getTargetValidationMetadatas(item.constructor, "", false, false)
              .filter(metadata => metadata.name === "isEnum" || metadata.name === "isIn")
              .map(metadata => metadata.propertyName)
          : []
      )
      if (object.asset_id || object.assetId || object.object_key || object.objectKey) {
        throw new BadRequestException({
          code: "MODERATION_UNSUPPORTED_REFERENCE",
          message: "参考素材需提供可审核的文件地址，暂不支持仅传素材ID或object_key",
        })
      }
      for (const [key, child] of Object.entries(object)) {
        if (!enumFields.has(key)) visit(child, `${path}.${key}`, key, object)
      }
      return
    }
    if (typeof item !== "string" || !item.trim()) return
    if (STRUCTURED_FIELDS.has(name) && /^\s*[[{]/.test(item)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(item)
      } catch {
        /* JSON格式错误仍交给原业务校验，原字符串不能漏审。 */
      }
      if (parsed && typeof parsed === "object") {
        visit(parsed, path, name, parent)
        return
      }
    }
    if (
      PROMPT_FIELD.test(name) ||
      (name === "content" &&
        (typeof parent.role === "string" || ["userContent", "messages"].includes(root)))
    ) {
      prompts.add(item.trim())
      return
    }
    const url = /^(?:https?:\/\/|data:|blob:)/i.test(item)
    const type = url ? mediaType(`${path} ${name}`, item, parent) : null
    if (url && !type && /^(?:url|uri|src)s?$/i.test(name)) {
      inputs.push({ key: path, type: "DOCUMENT", url: item, detectMime: true })
      return
    }
    if (type) {
      inputs.push({
        key: path,
        type,
        url: item,
        ...(type === "DOCUMENT" && typeof parent.documentType === "string"
          ? { documentType: parent.documentType }
          : {}),
      })
      return
    }
  }
  visit(value, root, root.split(".").pop() || root, {})
  const content = [...prompts].join("\n\n")
  const chars = Array.from(content)
  const texts: ModerationInput[] = []
  for (let start = 0; start < chars.length; start += 1800) {
    texts.push({
      key: `${root}.prompt.${start / 1800}`,
      type: "TEXT",
      content: chars.slice(start, start + 2000).join(""),
    })
    if (start + 2000 >= chars.length) break
  }
  const media = [
    ...new Map(
      inputs.map(input => [JSON.stringify([input.type, input.url, input.documentType]), input])
    ).values(),
  ]
  return [...texts, ...media]
}
