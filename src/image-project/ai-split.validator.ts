import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { AiModelModality, Prisma } from "@prisma/client"
import Ajv, { type ErrorObject } from "ajv"
import addFormats from "ajv-formats"
import axios from "axios"
import { lookup } from "dns/promises"
import { Agent } from "https"
import { isIP, type LookupFunction } from "net"
import {
  gatewayImageSizingSchema,
  normalizeGatewayImageSizing,
} from "../ai-gateway/gateway-image-sizing"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import {
  FALLBACK_MARKETPLACE_LANGUAGE,
  marketplaceLanguageLabel,
  resolveMarketplaceLanguage,
} from "../common/utils/marketplace-language"
import type { CreationSource } from "../common/types/creation-source"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import { COMPETITOR_SCHEMA } from "./ai-split-task.runner"
import { AiSplitCompetitorReferenceDto, AiSplitSite, CreateAiSplitTaskDto } from "./ai-split.dto"
import {
  AI_SPLIT_ANALYSIS_MODEL_CATEGORY,
  AI_SPLIT_IMAGE_MODEL_CATEGORY,
  AiSplitInputReferenceSnapshot,
  AiSplitProductImageSnapshot,
  isRecord,
} from "./ai-split.types"
import type { InternalAiSplitProductSnapshotDto } from "./internal-ai-split.dto"
import {
  buildPortraitImageTaskRequest,
  PORTRAIT_PROTECTED_MODEL_PARAM_KEYS,
} from "./portrait-image-generator"
import {
  planPortraitSizingWithGateway,
  PORTRAIT_RESOLUTION_TIERS,
  PortraitDeliveryPlan,
  ratioTierFromDimensions,
  type PortraitDeliveryTarget,
} from "./portrait-size-planner"

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MIN_REFERENCE_DIMENSION = 64
const MAX_REFERENCE_DIMENSION = 16_384
const MAX_REFERENCE_PIXELS = 100_000_000
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

const AI_SPLIT_PROTECTED_MODEL_PARAM_KEYS = new Set([
  ...PORTRAIT_PROTECTED_MODEL_PARAM_KEYS,
  "negative_prompt",
])

const PURPOSE_ORDER: Record<string, number> = {
  PRODUCT_MAIN: 0,
  PRODUCT_DETAIL: 1,
  ACCESSORY: 2,
  PACKAGING: 3,
  USAGE_SCENE: 4,
  LABEL_LOGO: 5,
  OTHER: 6,
}

interface ValidatedImageModel {
  id: number
  publicId: string
  displayName: string
  gatewayConfig: Prisma.JsonValue
  modelParams: Record<string, unknown>
  deliveryPlan?: PortraitDeliveryPlan
  supportsNegativePrompt: boolean
}

type ProductProfileWithLocalizations = Prisma.ProductProfileGetPayload<{
  include: { localizations: true }
}>

export interface AiSplitProjectSnapshot {
  project: { id: number; name: string; userId: number; type: string; status: string }
  currentProduct: Record<string, unknown>
  currentProductKeys: string[]
  productImages: AiSplitProductImageSnapshot[]
  /** 商品资料本地化取值 locale（站点国家码动态推导，查不到回落 en-US） */
  locale: string
  /** 图上文案语言显式标签（如 "Spanish (es-MX)"，查不到回落 English） */
  language: string
}

@Injectable()
export class AiSplitValidator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly gateway: AiGatewayProvider
  ) {}

  async loadAnalysisModel() {
    const models = await this.prisma.aiGatewayModel.findMany({
      where: {
        category: AI_SPLIT_ANALYSIS_MODEL_CATEGORY,
        modality: AiModelModality.TEXT,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: {
        id: true,
        publicId: true,
        displayName: true,
        execMode: true,
        gatewayConfig: true,
      },
    })
    // 分析模型不锚定代码常量：类目下唯一启用（enabled+gatewayActive）的同步文本模型即生效模型，
    // 由各环境数据库决定（如 dev 启用 3.1-Pro、uat 启用 3.7-Flash），切换只改数据不动代码
    if (models.length !== 1 || models[0].execMode !== "SYNC") {
      throw new ServiceUnavailableException("AI 拆图多模态分析模型未正确配置或未启用")
    }
    return models[0]
  }

  async validateImageModel(
    dto: Pick<CreateAiSplitTaskDto, "model" | "quantity" | "promptConfig" | "deliveryTarget">,
    productImages: AiSplitProductImageSnapshot[]
  ): Promise<ValidatedImageModel> {
    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId: dto.model,
        category: AI_SPLIT_IMAGE_MODEL_CATEGORY,
        modality: AiModelModality.IMAGE,
        enabled: true,
        gatewayActive: true,
      },
      select: { id: true, publicId: true, displayName: true, gatewayConfig: true },
    })
    if (!model) throw new BadRequestException("所选 AI 拆图生图模型不存在或未启用")

    // 有交付目标时，旧尺寸字段会被规划器覆盖，不能提前校验它们之间的冲突。
    const modelParams = dto.deliveryTarget
      ? { ...dto.promptConfig.model_params }
      : normalizeGatewayImageSizing({ ...dto.promptConfig.model_params })
    const protectedKey = Object.keys(modelParams).find(key =>
      AI_SPLIT_PROTECTED_MODEL_PARAM_KEYS.has(key)
    )
    if (protectedKey) {
      throw new BadRequestException(
        `promptConfig.model_params.${protectedKey} 由后端控制，不能传入`
      )
    }

    const sizePlan = await this.planDeliverySize(
      modelParams, dto.deliveryTarget, model.publicId,
      buildPortraitImageTaskRequest({
        nativeSizing: true,
        prompt: "AI 拆图参数校验",
        model: model.publicId,
        quantity: dto.quantity,
        referenceImages: productImages.map(image => ({ url: image.url, purpose: image.purpose })),
        modelParams,
      })
    )
    const config = this.asObject(sizePlan?.gatewayConfig ?? model.gatewayConfig)
    const detail = this.asObject(config?.detail)
    const facts = this.asObject(detail?.facts) ?? {}
    const schemaConfig = this.asObject(config?.requestSchema)
    const requestSchema = this.asObject(schemaConfig?.request_schema)
    if (!requestSchema) {
      throw new ServiceUnavailableException(`模型 ${model.displayName} 缺少请求参数配置`)
    }

    if (modelParams.output_format === undefined) {
      const formats = this.stringArray(facts.output_formats)
      if (formats.includes("png")) modelParams.output_format = "png"
      else if (formats.length > 0) modelParams.output_format = formats[0]
    }

    this.validateFactOption(
      model.displayName,
      modelParams,
      "quality",
      facts,
      "qualities",
      "质量",
      requestSchema
    )
    this.validateFactOption(
      model.displayName,
      modelParams,
      "output_format",
      facts,
      "output_formats",
      "输出格式",
      requestSchema
    )

    // 原生任务保留规划中的原值；其他请求继续 UAT 的格式和一致性校验。
    const plannedModelParams = sizePlan?.providerModelParams ?? modelParams
    if (plannedModelParams.output_format === undefined && modelParams.output_format !== undefined)
      plannedModelParams.output_format = modelParams.output_format
    const effectiveModelParams = sizePlan?.deliveryPlan.nativeSizing
      ? plannedModelParams : normalizeGatewayImageSizing(plannedModelParams)

    const modes = this.stringArray(facts.modes)
    if (modes.length > 0 && !modes.includes("edit")) {
      throw new BadRequestException(`模型 ${model.displayName} 不支持 edit 操作`)
    }
    const maxReferences = facts.max_reference_images
    if (typeof maxReferences === "number" && productImages.length > maxReferences) {
      throw new BadRequestException(`模型 ${model.displayName} 最多支持 ${maxReferences} 张参考图`)
    }
    const maxImages = facts.max_images_per_request
    if (typeof maxImages === "number" && dto.quantity > maxImages) {
      throw new BadRequestException(`模型 ${model.displayName} 单次最多生成 ${maxImages} 张图片`)
    }

    const request = buildPortraitImageTaskRequest({
      nativeSizing: sizePlan?.deliveryPlan.nativeSizing,
      prompt: "AI 拆图参数校验",
      model: model.publicId,
      quantity: dto.quantity,
      referenceImages: productImages.map(image => ({ url: image.url, purpose: image.purpose })),
      modelParams: effectiveModelParams,
    })
    let validateSchema: ReturnType<typeof ajv.compile>
    try {
      const compiler = addFormats(new Ajv({ allErrors: true, strict: false }))
      validateSchema = compiler.compile(gatewayImageSizingSchema(requestSchema))
    } catch {
      throw new ServiceUnavailableException(`模型 ${model.displayName} 的请求参数配置无效`)
    }
    if (!validateSchema(request)) {
      throw new BadRequestException(
        `模型参数不符合 ${model.displayName} 配置：${this.formatSchemaErrors(validateSchema.errors)}`
      )
    }

    return {
      ...model,
      modelParams: effectiveModelParams,
      deliveryPlan: sizePlan?.deliveryPlan,
      // 请求 Schema 是多上游路由的并集，出现字段不代表当前实际路由支持。
      // 只有模型能力事实明确声明时，才能把 negative_prompt 作为独立参数发送。
      supportsNegativePrompt: facts.supports_negative_prompt === true,
    }
  }

  /**
   * 按网关 intent 口径规划 AI 拆图的交付目标与提交参数（与人像同走 planPortraitSizing）。
   * 目标优先取显式 deliveryTarget（前端清晰度选择直传）；否则从 model_params 反推：
   * resolution/size 为固定像素时归一为比例+就近档位，为 1K～4K 档位时按档位+比例交付；
   * 两者都没有（仅比例或全空）时不规划，维持原样提交、原图转存。
   */
  private async planDeliverySize(
    modelParams: Record<string, unknown>,
    explicitTarget: PortraitDeliveryTarget | undefined,
    modelId: string,
    request: ReturnType<typeof buildPortraitImageTaskRequest>
  ) {
    if (explicitTarget) {
      // 显式交付目标优先；仅在比例缺省时用旧模型参数补齐。
      const legacyRatio =
        typeof modelParams.aspect_ratio === "string" && modelParams.aspect_ratio.trim() !== ""
          ? modelParams.aspect_ratio.trim()
          : null
      if (legacyRatio) {
        explicitTarget.aspectRatio ??= legacyRatio
      }
      return planPortraitSizingWithGateway({ target: explicitTarget, modelParams, modelId, request }, this.gateway)
    }
    const target = this.deliveryTarget(modelParams)
    return planPortraitSizingWithGateway({ target: target ?? { aspectRatio: typeof modelParams.aspect_ratio === "string" ? modelParams.aspect_ratio : "1:1", resolutionTier: "1K" }, modelParams, modelId, request }, this.gateway)
  }

  private deliveryTarget(modelParams: Record<string, unknown>): PortraitDeliveryTarget | null {
    const rawSize = [modelParams.resolution, modelParams.size].find(
      (value): value is string => typeof value === "string" && value.trim() !== ""
    )
    const aspectRatio =
      typeof modelParams.aspect_ratio === "string" && modelParams.aspect_ratio.trim() !== ""
        ? modelParams.aspect_ratio.trim()
        : null

    const tier = rawSize?.trim().toUpperCase()
    if (tier && (PORTRAIT_RESOLUTION_TIERS as readonly string[]).includes(tier)) {
      // 旧请求仅传档位时补齐默认方图比例。
      if (!aspectRatio) return { aspectRatio: "1:1", resolutionTier: tier as PortraitDeliveryTarget["resolutionTier"] }
      return {
        aspectRatio,
        resolutionTier: tier as PortraitDeliveryTarget["resolutionTier"],
      }
    }

    // 旧像素口径统一归一为 ratio 目标：保留原始宽高 + 就近档位（统一 ratio 模式，不指定像素输出）
    const dimensions = rawSize?.trim().match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
    if (dimensions) {
      const width = Number(dimensions[1])
      const height = Number(dimensions[2])
      if (width > 0 && height > 0) {
        return ratioTierFromDimensions(width, height)
      }
    }
    // width/height 数字形式（ planner 会统一剥离这些原始维度参数 ）
    if (
      typeof modelParams.width === "number" &&
      typeof modelParams.height === "number" &&
      modelParams.width > 0 &&
      modelParams.height > 0
    ) {
      return ratioTierFromDimensions(modelParams.width, modelParams.height)
    }
    return null
  }

  async buildProjectSnapshot(
    projectId: number,
    userId: number,
    site: AiSplitSite,
    input?: InternalAiSplitProductSnapshotDto,
    source: CreationSource = "platform"
  ): Promise<AiSplitProjectSnapshot> {
    const project = await this.prisma.imageProject.findUnique({
      where: { id: projectId, source },
      include: {
        productProfile: { where: { deletedAt: null }, include: { localizations: true } },
        productImages: {
          where: { deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })
    if (!project || project.userId !== userId) throw new NotFoundException("电商创作项目不存在")
    if (project.type !== "ECOMMERCE") throw new BadRequestException("该项目不是电商创作项目")
    if (project.status === "ARCHIVED")
      throw new BadRequestException("已归档项目不能创建 AI 拆图任务")
    if (!input && !project.productProfile)
      throw new BadRequestException("请先完善当前 SKU 商品资料")

    // 站点语言按国家码动态推导（平台无关，新站点零改动生效）：
    // locale 驱动商品资料本地化取值，language 是写给规划 LLM 的显式语言标签。
    // 国家码查不到时 locale 回落 en-US（资料无 en-US 本地化再走 defaultLocale
    // 既有回落），图上文案语言兜底英文。
    const marketplace = resolveMarketplaceLanguage(site) ?? FALLBACK_MARKETPLACE_LANGUAGE
    const locale = marketplace.locale
    const language = marketplaceLanguageLabel(marketplace)
    if (
      input &&
      (typeof input.currentProduct.productName !== "string" ||
        !input.currentProduct.productName.trim())
    ) {
      throw new BadRequestException("当前 SKU 商品名称不能为空")
    }
    const currentProduct = input
      ? (this.pruneEmpty({
          ...input.currentProduct,
          schemaVersion: "selleros.current_product.v1",
          locale,
          productName: (input.currentProduct.productName as string).trim(),
          attributes: this.normalizeAttributes(input.currentProduct.attributes),
        }) as Record<string, unknown>)
      : this.buildCurrentProduct(project.productProfile!, locale)
    const currentProductKeys = this.extractLeafPaths(currentProduct)
    const images = input
      ? input.productImages.map((image, index) => ({
          id: index + 1,
          url: image.url,
          purpose: image.purpose,
          note: image.description ?? null,
          order: index,
          tag: null,
          isPrimary: false,
        }))
      : project.productImages
    if (images.length === 0) throw new BadRequestException("请先上传当前 SKU 产品图")
    const productImages = images
      .map(image => {
        const purpose = image.purpose ?? this.legacyPurpose(image.tag, image.isPrimary)
        if (!purpose) throw new BadRequestException(`产品图 ${image.id} 未标注图片用途`)
        const description = image.note?.trim() || null
        if (["PACKAGING", "ACCESSORY", "OTHER"].includes(purpose) && !description) {
          throw new BadRequestException(`产品图 ${image.id} 用途为 ${purpose} 时必须填写说明`)
        }
        this.requireHttpsImageUrl(image.url, `产品图 ${image.id}`)
        return {
          id: image.id,
          index: 0,
          url: image.url,
          purpose,
          description,
          order: image.order,
        }
      })
      .sort(
        (a, b) =>
          (PURPOSE_ORDER[a.purpose] ?? 99) - (PURPOSE_ORDER[b.purpose] ?? 99) ||
          a.order - b.order ||
          a.id - b.id
      )
      .map((image, index) => ({
        id: image.id,
        index: index + 1,
        url: image.url,
        purpose: image.purpose,
        description: image.description,
      }))

    if (!productImages.some(image => image.purpose === "PRODUCT_MAIN")) {
      throw new BadRequestException("当前 SKU 至少需要一张 PRODUCT_MAIN 主图")
    }

    return { project, currentProduct, currentProductKeys, productImages, locale, language }
  }

  async resolveCompetitorReferences(
    inputs: AiSplitCompetitorReferenceDto[],
    projectId: number,
    userId: number
  ): Promise<AiSplitInputReferenceSnapshot[]> {
    const resolved: AiSplitInputReferenceSnapshot[] = []
    for (const input of inputs) {
      if (input.sourceType === "COMPETITOR_DATA") {
        // 与选图接口同一口径：竞品素材严格按项目隔离，只能引用本项目保存的图
        const image = await this.prisma.poolImage.findFirst({
          where: { id: input.sourceId, userId, projectId, url: { not: null } },
          select: { id: true, url: true },
        })
        if (!image?.url) throw new BadRequestException("所选竞品素材不存在或没有可用图片")
        this.requireHttpsImageUrl(image.url, "竞品素材")
        resolved.push({ sourceType: input.sourceType, sourceId: image.id, url: image.url })
        continue
      }

      const url = input.url!
      if (input.sourceType === "UPLOAD") {
        await this.validateUploadedImage(url)
      } else {
        await this.validateDirectImageUrl(url)
      }
      resolved.push({ sourceType: input.sourceType, url })
    }

    const unique = new Map<string, AiSplitInputReferenceSnapshot>()
    for (const reference of resolved) {
      const key = reference.sourceId
        ? `pool:${reference.sourceId}`
        : this.normalizeUrl(reference.url)
      if (unique.has(key)) throw new BadRequestException("竞品参考图不能重复")
      unique.set(key, reference)
    }
    return [...unique.values()]
  }

  validateReusableCompetitorTemplate(value: unknown, currentProductKeys: string[]) {
    let validateSchema: ReturnType<typeof ajv.compile>
    try {
      validateSchema = ajv.compile(COMPETITOR_SCHEMA)
    } catch {
      throw new ServiceUnavailableException("AI 拆图模板 Schema 配置无效")
    }
    if (!validateSchema(value) || !isRecord(value)) {
      throw new BadRequestException(
        `模板中的竞品拆解结构无效：${this.formatSchemaErrors(validateSchema.errors)}`
      )
    }

    // 正式模板的 variable_bindings.key 形如 product.fieldName；system_reserved 只允许
    // product.visualIdentity，其余 fieldName 必须来自当前 SKU 的 current_product_keys。
    const allowedFields = new Set(currentProductKeys)
    const bindings = value.variable_bindings
    if (!Array.isArray(bindings)) throw new BadRequestException("模板变量绑定格式无效")
    for (const binding of bindings) {
      if (!isRecord(binding) || typeof binding.key !== "string") {
        throw new BadRequestException("模板变量绑定格式无效")
      }
      if (binding.source === "system_reserved") {
        if (binding.key !== "product.visualIdentity") {
          throw new BadRequestException(
            `模板系统保留变量只允许 product.visualIdentity，实际为 ${binding.key}`
          )
        }
        continue
      }
      const field = binding.key.replace(/^product\./, "")
      if (!allowedFields.has(field)) {
        throw new BadRequestException(`模板引用了当前 SKU 不存在的商品字段：${binding.key}`)
      }
    }
    return value
  }

  async validateDirectImageUrl(url: string) {
    const parsed = this.requireHttpsImageUrl(url, "竞品图地址")
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true })
    if (addresses.length === 0 || addresses.some(item => this.isPrivateAddress(item.address))) {
      throw new BadRequestException("竞品图地址不允许访问内网或保留地址")
    }
    const target = addresses[0]
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [target])
      else callback(null, target.address, target.family)
    }
    const httpsAgent = new Agent({ lookup: pinnedLookup })

    let response
    try {
      response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 15_000,
        maxRedirects: 0,
        maxContentLength: MAX_REFERENCE_BYTES,
        httpsAgent,
        proxy: false,
        headers: { Accept: "image/jpeg,image/png,image/webp" },
      })
    } catch {
      throw new BadRequestException("竞品图地址无法直接访问或返回了重定向")
    } finally {
      httpsAgent.destroy()
    }
    const buffer = Buffer.from(response.data)
    const contentTypeHeader = response.headers["content-type"]
    const contentType =
      typeof contentTypeHeader === "string" ? contentTypeHeader.split(";")[0].toLowerCase() : ""
    this.validateImagePayload(buffer, contentType)
    const dimensions = this.imageDimensions(buffer, contentType)
    if (
      dimensions.width < MIN_REFERENCE_DIMENSION ||
      dimensions.height < MIN_REFERENCE_DIMENSION ||
      dimensions.width > MAX_REFERENCE_DIMENSION ||
      dimensions.height > MAX_REFERENCE_DIMENSION ||
      dimensions.width * dimensions.height > MAX_REFERENCE_PIXELS
    ) {
      throw new BadRequestException("竞品图分辨率必须在 64～16384 像素且总像素不超过 1 亿")
    }
    return { url, contentType, fileSize: buffer.length, ...dimensions }
  }

  private async validateUploadedImage(url: string) {
    this.requireHttpsImageUrl(url, "上传图片地址")
    let metadata: Awaited<ReturnType<SpacesService["getPublicObjectMetadata"]>>
    try {
      metadata = await this.spaces.getPublicObjectMetadata(url)
    } catch {
      throw new BadRequestException("上传图片不属于当前文件服务或尚未上传完成")
    }
    if (metadata.contentLength <= 0 || metadata.contentLength > MAX_REFERENCE_BYTES) {
      throw new BadRequestException("上传图片大小必须在 20MB 以内")
    }
    if (
      !metadata.contentType ||
      !["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType)
    ) {
      throw new BadRequestException("上传图片仅支持 JPG、PNG 或 WebP")
    }
  }

  private buildCurrentProduct(
    profile: ProductProfileWithLocalizations,
    locale: string
  ): Record<string, unknown> {
    const target = profile.localizations.find(item => item.locale === locale)
    const fallback = profile.localizations.find(item => item.locale === profile.defaultLocale)
    const targetContent = this.asObject(target?.content) ?? {}
    const fallbackContent = this.asObject(fallback?.content) ?? {}
    const localized = (key: string, base: unknown) =>
      targetContent[key] ?? fallbackContent[key] ?? base

    const product = {
      schemaVersion: "selleros.current_product.v1",
      locale,
      productName: localized("productName", profile.productName),
      sku: profile.sku,
      brandName: profile.brandName,
      categoryL1: localized("categoryL1", profile.categoryL1),
      categoryL2: localized("categoryL2", profile.categoryL2),
      categoryL3: localized("categoryL3", profile.categoryL3),
      targetCountries: profile.targetCountries,
      ecommercePlatforms: profile.ecommercePlatforms,
      commerce: profile.commerce,
      attributes: this.normalizeAttributes(localized("attributes", profile.attributes)),
      sellingPoints: localized("sellingPoints", profile.sellingPoints),
      certifications: localized("certifications", profile.certifications),
      audience: localized("audience", profile.audience),
      extra: localized("extra", profile.extra),
    }
    return this.pruneEmpty(product) as Record<string, unknown>
  }

  private normalizeAttributes(value: unknown): Record<string, unknown> | undefined {
    if (isRecord(value)) return this.pruneEmpty(value) as Record<string, unknown>
    if (!Array.isArray(value)) return undefined
    const result: Record<string, unknown> = {}
    for (const item of value) {
      if (!isRecord(item) || typeof item.key !== "string") continue
      const key = item.key
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[.[\]]/g, "_")
      if (!key) continue
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw new BadRequestException(`商品属性规范化后存在重复字段：${key}`)
      }
      result[key] = item.value
    }
    return this.pruneEmpty(result) as Record<string, unknown>
  }

  private extractLeafPaths(value: Record<string, unknown>, prefix = ""): string[] {
    const result: string[] = []
    for (const key of Object.keys(value).sort()) {
      if (key === "schemaVersion" || key === "locale") continue
      const field = value[key]
      const path = prefix ? `${prefix}.${key}` : key
      if (Array.isArray(field) || !isRecord(field)) result.push(path)
      else result.push(...this.extractLeafPaths(field, path))
    }
    return result
  }

  private pruneEmpty(value: unknown): unknown {
    if (Array.isArray(value)) {
      const rows = value.map(item => this.pruneEmpty(item)).filter(item => !this.isEmpty(item))
      return rows.length ? rows : undefined
    }
    if (isRecord(value)) {
      const rows = Object.entries(value)
        .map(([key, field]) => [key, this.pruneEmpty(field)] as const)
        .filter(([, field]) => !this.isEmpty(field))
      return rows.length ? Object.fromEntries(rows) : undefined
    }
    if (typeof value === "string") return value.trim() || undefined
    return value ?? undefined
  }

  private isEmpty(value: unknown) {
    return value === undefined || (Array.isArray(value) && value.length === 0)
  }

  private legacyPurpose(tag: string | null, isPrimary: boolean): string | null {
    if (isPrimary) return "PRODUCT_MAIN"
    const value = tag?.trim() ?? ""
    if (value.includes("主图")) return "PRODUCT_MAIN"
    if (value.includes("细节")) return "PRODUCT_DETAIL"
    if (value.includes("包装")) return "PACKAGING"
    if (value.includes("配件")) return "ACCESSORY"
    if (value.includes("场景")) return "USAGE_SCENE"
    if (value.includes("Logo") || value.includes("LOGO") || value.includes("标签"))
      return "LABEL_LOGO"
    return null
  }

  private validateFactOption(
    modelName: string,
    params: Record<string, unknown>,
    paramKey: string,
    facts: Record<string, unknown>,
    factsKey: string,
    label: string,
    requestSchema: Record<string, unknown>
  ) {
    if (params[paramKey] === undefined) return
    const properties = this.asObject(requestSchema.properties)
    const propertySchema = this.asObject(properties?.[paramKey])
    const options = this.stringArray(propertySchema?.enum)
    if (options.length === 0) options.push(...this.stringArray(facts[factsKey]))
    if (options.length === 0) {
      if (!propertySchema) {
        throw new BadRequestException(`模型 ${modelName} 不支持${label}参数 ${paramKey}`)
      }
      return
    }
    if (typeof params[paramKey] !== "string" || !options.includes(params[paramKey])) {
      throw new BadRequestException(`模型 ${modelName} 的${label}仅支持：${options.join("、")}`)
    }
  }

  private formatSchemaErrors(errors: ErrorObject[] | null | undefined) {
    if (!errors?.length) return "未知参数错误"
    return errors
      .slice(0, 5)
      .map(error => {
        const missing =
          "missingProperty" in error.params ? String(error.params.missingProperty) : ""
        const path = error.instancePath || (missing ? `/${missing}` : "/")
        return `${path} ${error.message ?? "不合法"}`
      })
      .join("；")
  }

  private validateImagePayload(buffer: Buffer, contentType: string) {
    if (!buffer.length || buffer.length > MAX_REFERENCE_BYTES) {
      throw new BadRequestException("竞品图大小必须在 20MB 以内")
    }
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const webp =
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
      (!jpeg && !png && !webp)
    ) {
      throw new BadRequestException("竞品图地址必须直接返回 JPG、PNG 或 WebP 图片")
    }
  }

  private imageDimensions(buffer: Buffer, contentType: string) {
    if (contentType === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (contentType === "image/jpeg") {
      const sofMarkers = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
      ])
      for (let offset = 2; offset + 9 < buffer.length;) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]
        if (marker === 0xd8 || marker === 0xd9) {
          offset += 2
          continue
        }
        const length = buffer.readUInt16BE(offset + 2)
        if (length < 2 || offset + length + 2 > buffer.length) break
        if (sofMarkers.has(marker)) {
          return {
            width: buffer.readUInt16BE(offset + 7),
            height: buffer.readUInt16BE(offset + 5),
          }
        }
        offset += length + 2
      }
    }
    if (contentType === "image/webp" && buffer.length >= 25) {
      const chunk = buffer.subarray(12, 16).toString("ascii")
      if (chunk === "VP8X" && buffer.length >= 30) {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        }
      }
      if (chunk === "VP8 " && buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        }
      }
      if (chunk === "VP8L" && buffer[20] === 0x2f) {
        return {
          width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
          height: 1 + ((buffer[22] & 0xc0) >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10),
        }
      }
    }
    throw new BadRequestException("无法读取竞品图分辨率")
  }

  private requireHttpsImageUrl(value: string, label: string): URL {
    try {
      const url = new URL(value)
      if (url.protocol !== "https:" || url.username || url.password) throw new Error()
      return url
    } catch {
      throw new BadRequestException(`${label}必须是可直接访问的 HTTPS 地址`)
    }
  }

  private isPrivateAddress(address: string): boolean {
    if (isIP(address) === 4) {
      const [a, b] = address.split(".").map(Number)
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224
      )
    }
    const normalized = address.toLowerCase()
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    )
  }

  private normalizeUrl(value: string) {
    const url = new URL(value)
    url.hash = ""
    return url.toString()
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  }
}
