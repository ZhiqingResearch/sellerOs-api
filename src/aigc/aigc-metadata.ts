import { createHash } from "node:crypto"

export const AIGC_PROVIDER = "ZQYK-SELLEROS"
export const AIGC_VERSION = "1"
export const AIGC_TEXT = "AI生成"

export interface AigcMetadata {
  AIGC: {
    Label: string
    ContentProducer: string
    ProduceID: string
    ReservedCode1: string
    ContentPropagator: string
    PropagateID: string
    ReservedCode2: string
  }
}

export function contentId(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex")
}

export function aigcMetadata(id: string, original?: AigcMetadata | null): AigcMetadata {
  return {
    AIGC: {
      Label: "1",
      ContentProducer: original?.AIGC.ContentProducer || AIGC_PROVIDER,
      ProduceID: original?.AIGC.ProduceID || id,
      ReservedCode1:
        typeof original?.AIGC.ReservedCode1 === "string" ? original.AIGC.ReservedCode1 : "",
      ContentPropagator: AIGC_PROVIDER,
      PropagateID: id,
      ReservedCode2: "",
    },
  }
}

export function parseAigc(value: string | undefined): AigcMetadata | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as AigcMetadata
    const fields = parsed.AIGC
    return fields?.Label === "1" &&
      typeof fields.ContentProducer === "string" &&
      fields.ContentProducer.length > 0 &&
      typeof fields.ProduceID === "string" &&
      fields.ProduceID.length > 0
      ? parsed
      : null
  } catch {
    return null
  }
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function readAigcXmp(xmp: string | undefined): AigcMetadata | null {
  const text = xmp?.match(/<(?:[\w-]+:)?AIGC(?:\s[^>]*)?>([^<]*)<\/(?:[\w-]+:)?AIGC>/)?.[1]
  return parseAigc(
    text
      ?.replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  )
}

export class AigcDeliveryError extends Error {
  readonly code = "AIGC_DELIVERY_FAILED"
  constructor() {
    super("生成结果标识处理未完成，请稍后重试")
    this.name = "AigcDeliveryError"
  }
}

export async function retryDelivery<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation()
    } catch {
      if (attempt === 2) throw new AigcDeliveryError()
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw new AigcDeliveryError()
}
