import type { Prisma } from "@prisma/client"

export function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export function gatewayOriginalUrl(value: unknown): string | null {
  const url: unknown = jsonObject(value).originalUrl
  return typeof url === "string" && url.trim() ? url : null
}

function pixelSize(value: unknown) {
  if (typeof value !== "string") return undefined
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (!match) return undefined
  const width = Number(match[1]),
    height = Number(match[2])
  return [width, height].every(n => Number.isSafeInteger(n) && n > 0)
    ? { width, height }
    : undefined
}

/** 网关已做过交付处理时，final_size 与 source_size 分别代表成品和模型原图。 */
export function gatewayImageDimensions(value: unknown) {
  const image: Record<string, unknown> = jsonObject(value)
  const metadata: Record<string, unknown> = jsonObject(image.metadata)
  const delivery: Record<string, unknown> = jsonObject(metadata.delivery)
  const normalized: Record<string, unknown> = jsonObject(image.normalized)
  const adaptation: Record<string, unknown> = jsonObject(jsonObject(image.adaptation).actual)
  const final = pixelSize(normalized.to) ?? pixelSize(delivery.final_size)
  const source = pixelSize(delivery.source_size) ?? pixelSize(normalized.from)
  const adapted = pixelSize(adaptation.size)
  const positive = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined
  return {
    width: final?.width ?? positive(image.width) ?? positive(metadata.width) ?? adapted?.width,
    height: final?.height ?? positive(image.height) ?? positive(metadata.height) ?? adapted?.height,
    nativeWidth:
      positive(image.nativeWidth) ??
      source?.width ??
      positive(metadata.width) ??
      positive(image.width) ??
      adapted?.width,
    nativeHeight:
      positive(image.nativeHeight) ??
      source?.height ??
      positive(metadata.height) ??
      positive(image.height) ??
      adapted?.height,
  }
}

/** 历史展示包含停用模型；空名称保持调用方原名称。 */
export async function modelDisplayNames(
  db: Pick<Prisma.TransactionClient, "aiGatewayModel">,
  publicIds: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const ids = [...new Set(publicIds.filter((id): id is string => !!id))]
  if (!ids.length) return new Map()
  const rows = await db.aiGatewayModel.findMany({
    where: { publicId: { in: ids } },
    select: { publicId: true, displayName: true },
    orderBy: { id: "asc" },
  })
  const names = new Map<string, string>()
  for (const row of rows) {
    if (row.displayName?.trim() && !names.has(row.publicId))
      names.set(row.publicId, row.displayName)
  }
  return names
}

export function videoMetadata(request: unknown, delivery: unknown) {
  const r = jsonObject(request)
  const d = jsonObject(delivery)
  return {
    requestedDurationSec:
      typeof r.duration_seconds === "number" && r.duration_seconds > 0 ? r.duration_seconds : null,
    requestedResolution: typeof r.resolution === "string" ? r.resolution : null,
    actualDurationSec:
      typeof d.actualDurationSec === "number" && d.actualDurationSec > 0
        ? d.actualDurationSec
        : null,
    actualResolution: typeof d.actualResolution === "string" ? d.actualResolution : null,
  }
}

export function imageMetadata(task: {
  model?: string | null
  executionSpec?: unknown
  deliveryPlan?: unknown
  promptConfig?: unknown
  generatedImages?: Array<{ deliveryMeta?: unknown }>
}) {
  const spec = jsonObject(task.executionSpec)
  const form = jsonObject(spec.form)
  const requested = jsonObject(jsonObject(task.deliveryPlan).requested)
  const redraw = jsonObject(spec.localRedraw ?? jsonObject(task.promptConfig).localRedraw)
  const redrawTier: unknown = redraw.resolutionTier ?? jsonObject(redraw.providerApplied).resolution
  const modelParams: Record<string, unknown> = jsonObject(
    jsonObject(jsonObject(task.promptConfig).generationSettings).modelParams
  )
  const tier = [modelParams.resolution, modelParams.size].find(
    (value): value is string => typeof value === "string" && /^[124]k$/i.test(value)
  )
  const outputId = task.generatedImages
    ?.map((i): unknown => jsonObject(jsonObject(i.deliveryMeta).gatewayImage).modelPublicId)
    .find((id): id is string => typeof id === "string")
  return {
    modelPublicId:
      typeof spec.modelPublicId === "string"
        ? spec.modelPublicId
        : (outputId ?? (spec.provider ? null : (task.model ?? null))),
    resolutionTier: Object.keys(redraw).length
      ? typeof redrawTier === "string" ? redrawTier.toUpperCase() : null
      : [form.resolutionTier, requested.resolutionTier, tier?.toUpperCase()].find(
        (value): value is string => typeof value === "string"
      ) ?? null,
  }
}
