import Ajv from "ajv"
import addFormats from "ajv-formats"
import { gatewayImageSizingSchema, resolveGatewaySizingIntent, type GatewaySizingIntent } from "./gateway-image-sizing"

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

/** 校验网关公共尺寸意图及完整请求，模型原生尺寸适配交给网关。 */
export function resolveGatewayImageSizing(
  snapshot: { detail: unknown; requestSchema: unknown },
  aspectRatio: string,
  resolutionTier: string,
  request: Record<string, unknown>,
): (GatewaySizingIntent & { quality?: string }) | null {
  const rawSchema = object(object(snapshot.requestSchema)?.request_schema)
  if (!rawSchema) throw new Error("缺少请求 Schema")
  const root = gatewayImageSizingSchema(rawSchema)
  const props = object(root.properties)
  const sizing: GatewaySizingIntent & { quality?: string } = resolveGatewaySizingIntent({ aspectRatio, resolutionTier })
  const qualityDefault = object(props?.quality)?.default
  if (request.quality === undefined && strings(root.required).includes("quality") && typeof qualityDefault === "string") {
    sizing.quality = qualityDefault
  }
  const ajv = new Ajv({ strict: false, allErrors: true })
  addFormats(ajv)
  return ajv.compile(root)({ ...request, ...sizing }) ? sizing : null
}
