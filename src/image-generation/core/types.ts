import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk";
// src/server/image/types.ts
//
// Shared contracts for the AI Creative 商品图生成 module. These types are the
// coordination boundary between:
//   - Backend: src/server/image/* + src/app/api/ai-creative/{generate,extract}/route.ts
//   - Frontend: src/app/(main)/ai-creative/product-image/page.tsx + components
//
// Keep in sync with src/components/ai-creative/types.ts (the client mirror).


/** Image provider identifiers — INTERNAL technical names used in API payloads,
 *  the model factory, and provider files. They map to customer-facing ZQ-Image-*
 *  labels exclusively at the UI layer (see `IMAGE_PROVIDER_LABELS`), never in
 *  routing logic.
 *
 *  Current UI lineup (4 visible models):
 *  - `gemini-nano-banana`   → Google Gemini (NanoBanana family)                     → ZQ-Image-1
 *  - `apifox-zq2-pro-plus`  → gpt-image-2 via Apifox gateway (OpenAI-compatible)    → ZQ-Image-2 (default)
 *  - `atlas-gpt`            → AtlasCloud-hosted GPT Image 2 (atlas-gpt.ts,
 *                             api.atlascloud.ai/api/v1/model/generateImage)         → ZQ-Image-2 备用
 *  - `atlas-wan`            → Alibaba Wan-2.7-Pro image-edit via AtlasCloud         → ZQ-Image-Spicy
 *
 *  Legacy / not in current lineup (still in the type union for cached
 *  form-state back-compat — page-level hydration guards reset stale values
 *  to default; image-creation task records persisted under these ids show
 *  the raw id as fallback in TaskCenterPanel):
 *  - `openai-gpt-image`     → gpt-image-2 via the nananobanana relay                → previously ZQ-Image-2
 *
 *  Decoupling the display label from the backing provider lets us swap the
 *  actual model behind a ZQ-Image-* slot without changing the API contract or the
 *  downstream routing. */
export type ImageProviderId =
  | "gemini-nano-banana"
  | "openai-gpt-image"
  | "atlas-gpt"
  | "atlas-wan"
  | "atlas-seedream"
  | "atlas-seedream-pro"
  | "apifox-zq2-pro-plus"
  | "chadgpt-ru"
  | "tokenlab-gpt-image";

/** Display label mapping — used by the UI "查看参数" modal, task card tooltips,
 *  and anywhere else the raw provider id would otherwise leak to end users.
 *  Routing code must NEVER use these strings — only the internal ids above.
 *
 *  Source of truth for "what is the current UI lineup" is the *order* arrays
 *  in `model-display.ts` (image-creation) and `ModelSelect.tsx` (image-to-image
 *  / product-image). This map covers ALL `ImageProviderId` values — including
 *  ones not in the current lineup — so debug output and task records that
 *  reference legacy provider ids still produce a human-readable label. */
export const IMAGE_PROVIDER_LABELS: Record<ImageProviderId, string> = {
  "gemini-nano-banana": "ZQ-Image-1",
  "apifox-zq2-pro-plus": "ZQ-Image-2",
  "atlas-gpt": "ZQ-Image-2 备用",
  "atlas-wan": "ZQ-Image-Spicy",
  "atlas-seedream": "ZQ-Image-Spicy 2",
  "atlas-seedream-pro": "ZQ-Image-Ultra",
  "chadgpt-ru": "ZQ-Image-3",
  "tokenlab-gpt-image": "ZQ-Image-4",
  // Not in current UI lineup; label kept descriptive so task records emitted
  // before the mapping change still render readably.
  "openai-gpt-image": "ZQ-Image-2 (legacy)",
};

/** 图片比例支持任意正整数宽:高；`custom` 兼容旧前端的独立宽高字段。
 *
 *  Extended in 2026-05 for the "图片创作" (Image Creation) tool which exposes
 *  the PRD-spec'd ratios (21:9, 9:16, 3:2, 2:3, 5:4, 4:5). The legacy
 *  /product-image and /image-to-image pages still only render the original 5
 *  options in their AspectPicker; widening the union doesn't break them
 *  because their component-level enumerations are independent. */
export type AspectRatio =
  | "1:1"
  | "3:4"
  | "4:3"
  | "16:9"
  | "21:9"
  | "9:16"
  | "3:2"
  | "2:3"
  | "5:4"
  | "4:5"
  | `${number}:${number}`
  | "custom";

/** User-facing output resolution tier. The exact pixel dimensions are resolved
 * by provider adapters because each upstream image API exposes size controls
 * differently. */
export type ResolutionTier = "1K" | "2K" | "3K" | "4K";

/** Language the image generator should use when rendering on-image text
 *  (selling-point copy, dimension annotations, packaging callouts, etc.).
 *
 *  - `"zh"` — render any on-image text in Simplified Chinese.
 *  - `"en"` — render any on-image text in English.
 *  - `"none"` — image-creation tool only (PRD §4.5 "无文字"): suppress all
 *    on-image text via prompt directives. Legacy /product-image and
 *    /image-to-image only ever send "zh" or "en". */
export type TargetLanguage = "zh" | "en" | "none";

/** How much on-image text the image creator should render. Image-creation
 *  tool only — split out from `TargetLanguage` so callers can independently
 *  pick "how much text" and "what language". When `textDensity === "none"`
 *  the language choice is moot and the prompt-builder emits a no-text
 *  directive regardless of `targetLanguage`.
 *
 *  - `"none"`    — no on-image text at all (matches `targetLanguage = "none"`)
 *  - `"minimal"` — at most 1-2 short labels
 *  - `"normal"`  — standard amount of labels / callouts (default)
 *  - `"rich"`    — feature callouts, dimensions, descriptive text */
export type TextDensity = "none" | "minimal" | "normal" | "rich";

/**
 * Built-in image type enum values (10 total). `customTypes[]` carries any
 * user-authored strings from the "自定义类型" input.
 */
export type ImageTypeKey =
  | "main_white_front"
  | "side_45"
  | "side_30"
  | "side_90"
  | "top_down"
  | "scene"
  | "size_annotation"
  | "selling_point"
  | "detail_closeup"
  | "packaging";

/** Quantitative on-image text count ranges per (language, density) cell —
 *  the contract the user picks via the 文字密度 (TextDensityTrack) control.
 *  EN is measured in *words*, ZH in *Chinese characters*. Both the prompt
 *  builder ([prompt-builder.ts:headDirective] / `tailDirective`) and the
 *  UI tooltips on the density track read from this single source so the
 *  numbers shown to the user always match what the model is asked to
 *  honour. */
export const ON_IMAGE_TEXT_COUNT_RANGES = {
  en: {
    minimal: { min: 3, max: 8, unit: "words", unitZh: "个英文单词" },
    normal: { min: 8, max: 16, unit: "words", unitZh: "个英文单词" },
    rich: { min: 16, max: 32, unit: "words", unitZh: "个英文单词" },
  },
  zh: {
    minimal: {
      min: 8,
      max: 16,
      unit: "Chinese characters",
      unitZh: "个中文字符",
    },
    normal: {
      min: 16,
      max: 28,
      unit: "Chinese characters",
      unitZh: "个中文字符",
    },
    rich: {
      min: 28,
      max: 40,
      unit: "Chinese characters",
      unitZh: "个中文字符",
    },
  },
} as const;

/** i18n labels — single source for both UI rendering and prompt construction. */
export const IMAGE_TYPE_LABELS: Record<
  ImageTypeKey,
  { zh: string; en: string }
> = {
  main_white_front: {
    zh: "主图·白底正面",
    en: "Main image, pure white background, front view",
  },
  side_45: { zh: "45°侧面", en: "45-degree side view" },
  side_30: { zh: "30°侧面", en: "30-degree side view" },
  side_90: { zh: "90°侧面", en: "90-degree side view" },
  top_down: { zh: "俯视图", en: "Top-down overhead view" },
  scene: {
    zh: "场景图",
    en: "Lifestyle scene showing the product in real use",
  },
  size_annotation: {
    zh: "尺寸标注图",
    en: "Dimension annotation diagram with measurements",
  },
  selling_point: {
    zh: "卖点图",
    en: "Selling-point infographic highlighting key features",
  },
  detail_closeup: {
    zh: "细节特写",
    en: "Close-up macro detail view showing material and craftsmanship",
  },
  packaging: {
    zh: "包装配件图",
    en: "Packaging and accessories laid out neatly",
  },
};

/** Discriminator for which sub-tool is calling the generate route.
 *  - `"product-image"` (default when absent) → legacy 商品图生成 flow:
 *      uses imageTypes + customTypes to fan out one image per type.
 *  - `"image-creation"` → the unified 图片创作 tool:
 *      uses prompt + count, mainImages array, optional attachedRefs / productInfo /
 *      brandIdentity, ignores imageTypes/customTypes. */
export type GenerateMode = "product-image" | "image-creation";

/** Product info captured by the right-slide 产品资料 panel (PRD §2.2 Tab1).
 *  Stage A wire-up only requires the type to exist; many fields will be
 *  populated by stage B's /api/ai-creative/extract-rich. */
/** Structured key-value attribute row used by the 商品属性 KV list
 *  (PRD §4 of product-resource drawer refactor). Keys come from a preset
 *  chip palette (材质/颜色/尺寸/…) or free-form user input; values are
 *  arbitrary strings. Prompt-builder concatenates them as "key: value"
 *  lines when emitting product facts. */
export interface ProductAttribute {
  key: string;
  value: string;
}

/** Read-only commerce metadata captured from a link-scrape (区块 3 商业数据
 *  + 区块 5 抓取来源). Never user-edited — populated only by the
 *  fetchProductDetailByUrl mapping path. */
export interface CommerceData {
  /** Display price (e.g. "USD 45.00"). */
  price?: string;
  /** Display rating (e.g. "4.8"). */
  rating?: string;
  /** Review count display (e.g. "28956"). */
  reviewCount?: string;
  /** Category BSR (e.g. "#1 in Tumblers & Water Bottles"). */
  bsr?: string;
  /** Number of variants / SKUs. */
  variantCount?: number;
  /** "FBA" / "FBM" / "Walmart Fulfilled" / etc. */
  fulfillment?: string;
  /** Source platform: "amazon" / "walmart" / ... */
  sourcePlatform?: string;
  /** Source product id (ASIN / Walmart item id). */
  sourceProductId?: string;
  /** Original URL the user pasted. */
  sourceUrl?: string;
  /** "Home & Kitchen > Kitchen & Dining > Drinkware > Tumblers" */
  sourceCategoryPath?: string;
  /** Unix ms when this scrape ran. */
  sourceFetchedAt?: number;
  /** Candidate product image URLs (≤5 typical). */
  sourceImages?: string[];
}

export interface ProductInfoSnapshot {
  productName: string;
  /** Multi-select with custom input (PRD §2 of refactor). Values are free-form
   *  country names ("US" / "美国" / "United Kingdom" / etc.); presets in
   *  constants.ts but users may add custom values. Was `string` pre-2026-05;
   *  the IndexedDB hydrate path in image-creation-store normalizes legacy
   *  single-string records to `[value]`. */
  targetCountry?: string[];
  /** Multi-select with custom input. Same single-string→array migration as
   *  targetCountry. */
  ecommercePlatform?: string[];
  categoryL1?: string;
  categoryL2?: string;
  spec?: string;
  size?: string;
  coreSellingPoints?: string[];
  certifications?: string[];
  audiencePersona?: string;
  ageGroup?: string;
  consumerTier?: string;
  ingredients?: string;
  usageInstructions?: string;
  shelfLife?: string;
  textureFinish?: string;
  structureFeature?: string;
  packagingFeature?: string;
  productDescription?: string;
  /** Structured product attributes (区块 4). Replaces ad-hoc平铺字段 like
   *  textureFinish for the new product-resource drawer. Old fields above
   *  are kept for back-compat with legacy records — prompt-builder will
   *  emit either form. */
  attributes?: ProductAttribute[];
  /** Read-only commerce data from a link-scrape (区块 3 + 区块 5). */
  commerceData?: CommerceData;
}

/** Brand identity captured by the 品牌基因 tab (PRD §2.2 Tab2). */
export interface BrandIdentitySnapshot {
  brandNameZh?: string;
  brandNameEn?: string;
  /** Hex strings, max 5. */
  primaryColors?: string[];
  /** Preset + custom design style tags. */
  designStyles?: string[];
  /** Preset + custom pattern element tags. */
  patternElements?: string[];
  fontStyle?: string;
  /** Logo image (data URL or persistent URL). */
  logoUrl?: string;
  /** Brand reference image (Spaces publicUrl). Source for 主色调 auto-extract
   *  (median-cut) and persisted as part of the brand gene. */
  brandImageUrl?: string;
  /** "生成时应用品牌色" — when on, 主色调 drives background/graphic elements at
   *  generation time. Defaults to ON (undefined === true). Wire name
   *  `applyBrandColor` (singular) per the backend DTO. */
  applyBrandColor?: boolean;
  brandTone?: string;
}

/** Product form fields posted from the client (JSON part of multipart). */
export interface ProductImageGenerateForm {
  projectId?: string;
  /** Which sub-tool is calling. Absent / "product-image" preserves legacy
   *  behavior; "image-creation" switches the route into prompt+count mode. */
  mode?: GenerateMode;
  /** 局部重绘原样使用编辑指令，不套用通用生图的语言、字数或营销模板。 */
  editMode?: "local-redraw"
  productName: string;
  categoryL1: string;
  categoryL2: string;
  productDescription?: string;
  provider: ImageProviderId;
  aspectRatio: AspectRatio;
  customAspectW?: number;
  customAspectH?: number;
  /** How `customAspectW`/`customAspectH` are interpreted when
   *  `aspectRatio === "custom"`:
   *    - `"ratio"` (default, back-compat) → ratio numerators (e.g. 16:9)
   *    - `"pixels"` → actual output pixel dimensions; tier is ignored
   *  The image-creation tool's custom W:H input sends "pixels"; legacy
   *  product-image / image-to-image custom inputs send "ratio". */
  customSizeMode?: "ratio" | "pixels";
  resolutionTier: ResolutionTier; // user-facing 1K / 2K / 4K selection
  /** Back-compat display field. New code should derive provider-native size
   *  from `resolutionTier + aspectRatio` through size-adapters.ts. */
  resolution: string; // e.g. "1024x1024"
  imageTypes: ImageTypeKey[]; // subset of the 10 enum values (legacy mode)
  customTypes: string[]; // free-text custom prompts (legacy mode)
  /** 站点选择（前端站点下拉，`平台_国家码` 格式，如 "amazon_us"）。设置后
   *  图上文字语言由站点商城语言硬性决定（common/utils/marketplace-language
   *  按国家码动态推导），优先于 targetLanguage 与"跟随提示词语言"规则；
   *  解析不出国家时回落英文指令。缺省时行为与现状逐字节一致。 */
  market?: string;
  targetLanguage: TargetLanguage; // enforced language for on-image text
  /** image-creation only — how dense the on-image text should be. Optional
   *  for back-compat; the prompt-builder defaults to "normal" when absent
   *  (i.e. legacy product-image / image-to-image submissions behave exactly
   *  as before). */
  textDensity?: TextDensity;
  /** image-creation only — which page submitted the prompt. Selects the
   *  text-density directive shape: "ecommerce" (电商创作) uses structural
   *  marketing composition guidance, "general" (通用创作) keeps the legacy
   *  word-count band. Optional; the prompt-builder defaults to "ecommerce". */
  imageCreationVariant?: "general" | "ecommerce";
  /** 套图方案生成图的命名基名（板块名 / `套图N`）。透传给后端任务创建，落库到
   *  任务的 `imageLabelBase`，任务查询回读，前端据此渲染卡片标题 + 下载文件名。
   *  普通生成为空。 */
  imageLabelBase?: string;
  /** Optional — when set, the route uses this prompt verbatim instead of
   *  calling buildImagePrompt. Applies to every item in the request (regen
   *  requests always send exactly one item, so effectively it targets that
   *  one image). Trim before sending; blanks fall back to the built prompt. */
  promptOverride?: string;

  // ── image-creation mode (PRD 图片创作工具) ─────────────────────────────
  /** Free-form user prompt. Used as the seed text when mode==="image-creation".
   *  Bracketed by language directives + aspect/resolution suffix at build time. */
  prompt?: string;
  /** image-creation only — the user's raw composer text, for ARCHIVING (not
   *  generation). The backend task record's `prompt` field stores this, so a
   *  restored task's PROMPT panel shows what the user actually typed. Only
   *  needed when the `prompt` field itself carries a client-composed wire
   *  prompt (e.g. 标注框重生成 restates each 框N instruction); when absent,
   *  the route archives `prompt` as-is. */
  displayPrompt?: string;
  /** Number of images to generate per submit. PRD default 4, range 1..N. */
  count?: number;
  /** image-creation only — main reference images supplied BY HOSTED URL instead
   *  of a multipart upload. The route fetches each one server-side (full
   *  quality, no client re-encode) and prepends them to the reference list,
   *  BEFORE any `mainImages` file entries — so the effective main order is
   *  `[...mainImageUrls, ...mainImages]`. Used by 重新生成 to feed the previous
   *  frame by its CDN/Spaces address (avoids the lossy download→recompress→
   *  reupload round-trip that was softening iterated 局部重绘 results). */
  mainImageUrls?: string[];
  /** image-creation (电商创作) only — per-product-image role labels (产品/细节/
   *  包装/配件 or a custom string). Position-paired with the multipart
   *  `mainImages` file entries; the prompt-builder appends each label to its
   *  `[产品图N]` reference-map line so the model knows what each image is
   *  (e.g. which is an accessory vs. the main product). Missing/blank entries
   *  fall back to 产品. */
  mainImageCategories?: string[];
  /** Per-attachment provenance. Lets the prompt-builder label each ref in
   *  the reference map by where it came from so the LLM can resolve text
   *  tokens like `[生成图3]` to the exact image. Position-paired with the
   *  multipart `attachedRefs` array; falls back to "paperclip" for missing
   *  entries. */
  attachedRefsSources?: AttachedRefSource[];
  /** Per-attachment chip number for `source === "generated"` entries.
   *  Carries the N that appears in the editor's `[生成图N]` chip so the
   *  reference map can include the same N as a label ("Image M labeled
   *  [生成图N]"). Position-paired with attachedRefsSources; null for
   *  non-generated entries. */
  attachedRefsChipNumbers?: (number | null)[];
  /** Pre-formatted chip-token strings (e.g. `"[生成图3-2]"`, `"[图5]"`)
   *  for each attachment, when known. When present, the prompt-builder
   *  splices these directly into reference-map lines — required for the
   *  new composite `[生成图T-N]` form where the chip identity is no
   *  longer a single integer. Validated upstream to match
   *  `^\[(产品图|主图|生成图|图)\d+(-\d+)?\]$`; null entries fall back
   *  to chipNumber-driven legacy formatting in the builder. */
  attachedRefsChipTokens?: (string | null)[];
  /** Snapshot of the product-info panel forwarded to the prompt-builder. */
  productInfo?: ProductInfoSnapshot;
  /** Snapshot of the brand-identity panel forwarded to the prompt-builder. */
  brandIdentity?: BrandIdentitySnapshot;
}

/** Where an attached reference came from in the image-creation UI. Mirrors
 *  the client-side AttachedRefSource (defined in AttachedRefsRail.tsx) so the
 *  server can label each ref without importing client code.
 *
 *  `brand-logo` is server-injected (not a UI attachment): the brand gene's
 *  `logoUrl` is fetched and appended as the last attached ref so the prompt's
 *  reference map can call out exactly which image is the brand logo. */
export type AttachedRefSource = "paperclip" | "main" | "generated" | "brand-logo";

/** A single in-flight / finished image generation within one submission. */
export interface ImageTaskItem {
  /** 0-based index within the submission (stable across all SSE events). */
  index: number;
  /** Either a known ImageTypeKey or a custom prompt string (prefixed "custom:"). */
  typeKey: string;
  /** Human label for UI (e.g. "主图·白底正面"). */
  label: string;
}

// ── SSE event shapes ────────────────────────────────────────────────────────

/** Emitted once at the start of a generate request. */
export interface ImageStartEvent {
  type: "start";
  taskId: string;
  total: number;
  items: ImageTaskItem[];
}

/** Emitted as each image finishes. `url` may be a data: URL or a served URL. */
export interface ImageReadyEvent {
  type: "image_ready";
  index: number;
  url: string;
  mimeType: string;
}

/** Emitted when an individual image fails (does not abort others). */
export interface ImageFailedEvent {
  type: "image_failed";
  index: number;
  message: string;
}

/** Mirrors consumeAiSSE's UsageEvent — auto-harvested into AiTaskResult. */
export interface ImageUsageEvent {
  type: "usage";
  usage: TokenUsage;
}

/** Mirrors consumeAiSSE's McpUsageEvent — always 0 for this module. */
export interface ImageMcpUsageEvent {
  type: "mcp_usage";
  totalCalls: number;
  callDetail?: Record<string, number>;
}

/** Terminal fatal error — ends the stream. */
export interface ImageErrorEvent {
  type: "error";
  message: string;
}

/** Union of every event the generate route can emit. */
export type ImageGenerateEvent =
  | ImageStartEvent
  | ImageReadyEvent
  | ImageFailedEvent
  | ImageUsageEvent
  | ImageMcpUsageEvent
  | ImageErrorEvent;

// ── Provider contract ───────────────────────────────────────────────────────

export interface ReferenceImageInput {
  /** MIME type like "image/jpeg" or "image/png". */
  mimeType: string;
  /** Raw base64, no data URI prefix. */
  base64: string;
  /** 来源 URL(Spaces 托管地址),执行器在转 base64 的同时保留 —— 网关适配器
   *  的 MediaReference 直接传 URL,免去 base64 往返;直连 provider 忽略。 */
  url?: string;
}

export interface ProviderGenerateInput {
  /** 已成功生成的任务只恢复产物处理，不重新提交收费任务。 */
  resumeTaskId?: string;
  onGenerated?: (taskId: string) => Promise<void>;
  localRedraw?: import("../local-redraw.constants").LocalRedrawPlan
  referenceImages: ReferenceImageInput[];
  prompt: string;
  /** 补边/contain 交付时为 false，避免追加中心裁剪承诺。 */
  centerCrop?: boolean;
  aspectRatio: AspectRatio;
  customAspectW?: number;
  customAspectH?: number;
  /** See `ProductImageGenerateForm.customSizeMode`. */
  customSizeMode?: "ratio" | "pixels";
  resolutionTier: ResolutionTier;
  resolution: string;
  signal?: AbortSignal;
  /** 稳定幂等键(轨道 B):`imggen:{jobId|taskId}:{itemId|imageId}:{attemptNo}`
 *  (前缀单一来源 IMAGE_PIPELINE_IDEMPOTENCY_PREFIX,webhook 据此识别管线任务
 *  的晚到回调)。由执行器在认领后填充 —— 网关适配器用它防重复提交/重复
 *  计费;直连 provider 忽略。 */
  idempotencyKey?: string;
  /** Authenticated user's bearer token — forwarded from the route layer.
   *  Required by providers that need to call back into the project's own
   *  APIs (e.g. wan-2.7-pro uploads references to our DigitalOcean Space
   *  via /api/spaces/upload-url before handing the public URL to
   *  AtlasCloud). */
  authToken?: string;
  /** Target-size delivery: the planner's working size — the image we actually
   *  want generated, before the Finalizer crops/pads/extends it to the exact
   *  delivery size. When set, gpt-family adapters generate at this size instead
   *  of deriving one from aspectRatio/customAspect. Providers without W×H
   *  control (Gemini enumerated ratios, Wan) ignore it. */
  workingWidth?: number;
  workingHeight?: number;
}

export interface GatewayImageInfo {
  /** 独立转存的网关原始文件，未经过本地裁剪、缩放或格式转换。 */
  originalUrl?: string;
  /** 网关能力与完整请求校验通过，原图交付，跳过本地尺寸适配。 */
  nativeSizing?: boolean;
  /** 已按用户比例完成交付处理，执行器无需再按像素尺寸缩放。 */
  ratioDelivery?: boolean;
  modelPublicId?: string;
  nativeWidth?: number;
  nativeHeight?: number;
  width?: number;
  height?: number;
  /** 原样保留 requested / actual / changes；未知值不以用户选择冒充。 */
  adaptation?: ImageTask["adaptation"];
  metadata?: Record<string, unknown>;
  /** 尺寸归一化落点(2026-09-10):产物被裁/缩回表单目标尺寸时记录
   *  from(原始实测)/to(归一后)/ops(操作序列);未触发归一无此字段。 */
  normalized?: { from: string; to: string; ops: string[] };
  /** 尺寸能力降档留痕(2026-09-22):提交前预检降档/失败降档重提的说明链,
   *  如「清晰度档位 4k 超出模型尺寸能力,降档 2k 生成」;未降档无此字段。 */
  sizingAdjusted?: string[];
}

export interface ProviderGenerateResult {
  gatewayImage?: GatewayImageInfo;
  /** Data URL or served URL for the generated image. */
  url: string;
  mimeType: string;
  /** Optional token usage (OpenAI images don't return this — providers synthesize). */
  tokenUsage?: TokenUsage;
  /** 网关计费金额(CNY,Decimal 字符串,轨道 B D4 决议):由网关适配器从
   *  TaskUsage.amount 回填;执行器见此值改走 chargeGatewayUsageInTransaction,
   *  直连 provider 不返回。 */
  costAmountCny?: string;
  /** 网关任务 id(审计/对账用)。 */
  gatewayTaskId?: string;
}

export interface ImageProvider {
  /** 逻辑 provider ID,或网关 model id(轨道 B 目录直传场景)——
   *  放宽为 string:注册表键仍按 ImageProviderId 联合收窄。 */
  readonly id: string;
  /**
   * Generate ONE image. The route layer fans out across N imageTypes/customTypes,
   * so each provider call produces exactly one image. Keeping the provider
   * atomic makes concurrency + progress reporting trivial at the route layer.
   */
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}

// ── Extract route shapes ────────────────────────────────────────────────────

export interface ProductImageExtractResult {
  productName: string;
  categoryL1: string;
  categoryL2: string;
  productDescription: string;
}

export interface ProductImageExtractResponse {
  data: ProductImageExtractResult;
  tokenUsage?: TokenUsage;
}

// ── Extract-rich (图片创作 AI 自动填充) ─────────────────────────────────────

/** Stage B will populate this via /api/ai-creative/extract-rich (Gemini Pro
 *  with optional google_search grounding). The shape mirrors PRD §2.2 Tab1
 *  exactly so the frontend can splat it into the panel form draft. */
export interface ProductImageExtractRichResult extends ProductInfoSnapshot {
  productName: string;
  /** Brand-identity fields populated from the same single AI fill call —
   *  routed into the 品牌基因 form via fill-empty-only merge. */
  brandIdentity?: BrandIdentitySnapshot;
  /** Cross-cultural visual recommendations tailored to targetCountry +
   *  ecommercePlatform. Surfaced in the panel as inline tips next to the
   *  matching fields. All sub-fields are optional / may be empty. */
  recommendations?: ProductImageExtractRecommendations;
}

export interface ProductImageExtractRecommendations {
  /** e.g. 「日式杂志清新风」「中东金属质感奢华风」. */
  visualStyle?: string;
  /** e.g. 「大字标题 + 数据卖点 + 角标认证」. */
  textEffect?: string;
  /** Localised use-scenario hint, e.g. 「美国户外草坪 BBQ」. */
  sceneRecommendation?: string;
  /** Free-form combined hint covering 模特/场景/数据可视化 needs. */
  specialRequirements?: string;
  /** Suggested copy language for the listing/poster, e.g. 「英语」「阿拉伯语」. */
  language?: string;
}

export interface ProductImageExtractRichResponse {
  data: ProductImageExtractRichResult;
  tokenUsage?: TokenUsage;
}

// Ported verbatim from amazon-agent src/lib/sse-consumer.ts — the only shared
// type the image core depended on outside src/server/image.
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 思考 token,Gemini reasoning 用量;后端按输出计费。 */
  thinkingTokens?: number;
  /** 累计 token(有则透传,后端计费不使用此字段)。 */
  totalTokens?: number;
}
