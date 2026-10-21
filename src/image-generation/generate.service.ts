// src/image-generation/generate.service.ts
//
// 主生图(generate)创建/取消,行为逐条对齐 amazon-agent 的
// src/app/api/ai-creative/generate 路由(POST 主路由 + /cancel):
//   - parseForm 与校验(provider allowlist、mode 分支 image-creation / 旧
//     product-image、aspectRatio/count 钳制、image-creation 专属字段清洗),
//    任何 parse 失败统一 400 "Invalid or missing `form` field"(照源);
//   - prompt 编译选择(IMAGE_PROMPT_STRUCTURED 环境开关 →
//     buildImageCreationPromptStructured;promptOverride 直通;否则
//     buildImageCreationPrompt;legacy 模式 buildImagePrompt /
//     buildWanEditPrompt(atlas-wan));
//   - 引用图上传 Spaces([...urlMains, ...fileMains, ...attachedRefs, logo]
//     顺序契约不可重排,结构化 prompt 的引用图编号依赖它),refImageUrls 落任务;
//   - 建任务:直接进程内调 ImageProjectService.createTask,载荷字段与 Next
//     现在发给 API 的 createTaskDto 完全一致(model 别名走 IMAGE_PROVIDER_LABELS,
//     即前端 providerIdToModelAlias 的映射源);
//   - 响应 {success:true, taskId:number, generatedImages:[{id,order,status:"GENERATING"}]},
//     执行由 DispatchQueue 后台跑 GenerationTaskRunnerService(源 after() 等价物,
//     openai-gpt-image 逐张串行、其余并行,照源)。
//
// 与源路由的差异仅在执行位置与真相源:源路由把引用图 base64 留在请求内存里
// 供 after() 使用,这里上传 Spaces 后把 URL 冻结进 executionSpec,执行器拉回
// base64 喂 provider——用户可见契约不变。源路由允许无 projectId(SSE 仍可流式,
// 任务不落库),后端执行器以 GenerationTask 行为真相源,projectId 缺失直接 400。
// 源路由建任务失败返回 502 "无法连接后端服务(...)":这里进程内调用,失败同样
// 502,消息保留前缀、detail 换成进程内错误。

import { HttpException, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import {
  FALLBACK_MARKETPLACE_LANGUAGE,
  marketplaceLanguageHead,
  marketplaceLanguageTail,
  resolveMarketplaceLanguage,
  type MarketplaceLanguage,
} from "../common/utils/marketplace-language";
import { ImageProjectService } from "../image-project/image-project.service";
import type { CreationSource } from "../common/types/creation-source";
import { PrismaService } from "../prisma/prisma.service";
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider";
import { UsageService } from "../usage/usage.service";
import { imageCreationRenderLevelForProvider } from "./core/image-creation-render-level";
import type { DeliveryPlan } from "./core/delivery-types";
import { deliveryPlanForForm } from "./core/delivery-finalize";
import {
  buildImageCreationPrompt,
  buildImageCreationPromptStructured,
  buildImagePrompt,
} from "./core/prompt-builder";
import { isImageAspectRatio, normalizeResolutionTier, resolveTargetImageSize } from "./core/size-adapters";
import { uploadBytesToSpaces } from "./core/storage";
import {
  IMAGE_PROVIDER_LABELS,
  IMAGE_TYPE_LABELS,
  type AspectRatio,
  type AttachedRefSource,
  type ImageProviderId,
  type ImageTypeKey,
  type ProductImageGenerateForm,
} from "./core/types";
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import { loadImageGenerationFixedCredits } from "./models.service";
import { prepareLocalRedraw } from "./local-redraw"
import { LOCAL_REDRAW_CATEGORY, LocalRedrawPlan } from "./local-redraw.constants"
import { resolveGatewayModel } from "./providers/gateway-mapping";
import {
  CANCELLED_MESSAGE,
  GenerationTaskRunnerService,
  type GenerationExecutionSpec,
} from "./executor/generation-task-runner.service";

const CUSTOM_PREFIX = "custom:";

/** 任务 deadline = 创建 + 11 分钟(前端 10 分钟超时 + 1 分钟宽限;
 *  前端自己的超时先生效,后端对账只做兜底收敛,不产生状态倒挂)。 */
export const GENERATION_DEADLINE_MS = 11 * 60_000;

/** Feature flag:结构化 prompt 编译器(v7)。IMAGE_PROMPT_STRUCTURED === "on"
 *  时 image-creation 模式把 promptOverride 当 user brief 过编译器(无裸直通)
 *  并产出结构化 metadata;其余值(含未设)保持 legacy 路径,回滚只需改环境
 *  变量。函数形态,调用时读取,测试可即时切换。 */
function isPromptStructuredEnabled(): boolean {
  return process.env.IMAGE_PROMPT_STRUCTURED === "on";
}

function isImageTypeKey(key: string): key is ImageTypeKey {
  return Object.prototype.hasOwnProperty.call(IMAGE_TYPE_LABELS, key);
}

const parseFormLogger = new Logger("generate.parseForm");

function parseWarn(message: string): void {
  parseFormLogger.warn(`[generate.parseForm] ${message}`);
}

/** 源路由 parseForm 的逐行移植(接受/拒绝决策与强制转换完全一致;
 *  拒绝一律返回 null,由调用方统一回 400)。 */
function parseForm(raw: unknown): ProductImageGenerateForm | null {
  if (typeof raw !== "string") {
    parseWarn(`reject: form field is ${typeof raw}, not string`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    parseWarn(
      `reject: JSON parse failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    parseWarn(`reject: parsed payload is ${typeof parsed}, not object`);
    return null;
  }
  const f = parsed as Partial<ProductImageGenerateForm>;
  const mode = f.mode === "image-creation" ? "image-creation" : "product-image";
  if (f.editMode !== undefined && (f.editMode !== "local-redraw" || mode !== "image-creation")) {
    return null
  }
  if (typeof f.productName !== "string") {
    if (mode === "image-creation") {
      (f as { productName: string }).productName = "";
    } else {
      parseWarn(
        `reject: product-image mode requires productName string, got ${typeof f.productName}`,
      );
      return null;
    }
  }
  if (typeof f.categoryL1 !== "string") {
    if (mode === "image-creation") {
      (f as { categoryL1: string }).categoryL1 = "";
    } else {
      parseWarn("[generate.parseForm] reject: product-image mode requires categoryL1 string");
      return null;
    }
  }
  if (typeof f.categoryL2 !== "string") {
    if (mode === "image-creation") {
      (f as { categoryL2: string }).categoryL2 = "";
    } else {
      parseWarn("[generate.parseForm] reject: product-image mode requires categoryL2 string");
      return null;
    }
  }
  if (
    f.editMode !== "local-redraw" && (typeof f.provider !== "string" ||
    resolveGatewayModel(f.provider) === null)
  ) {
    // B4(2026-09-10)网关单通道:退役槽位(无网关对应)拒绝;
    // 目录直传的动态 model id(9 个逻辑 ID 之外)放行,由网关校验。
    parseWarn(
      `reject: provider="${String(f.provider)}" retired or non-string (no gateway mapping)`,
    );
    return null;
  }
  if (
    f.editMode !== "local-redraw" && f.aspectRatio !== "custom" &&
    !isImageAspectRatio(f.aspectRatio)
  ) {
    parseWarn(
      `reject: aspectRatio="${String(f.aspectRatio)}" must be positive integer width:height or custom`,
    );
    return null;
  }
  const legacyResolution =
    typeof f.resolution === "string" && f.resolution.trim().length > 0
      ? f.resolution
      : "1024x1024";
  const resolutionTier = normalizeResolutionTier(
    (f as { resolutionTier?: unknown }).resolutionTier,
    legacyResolution,
  );
  // imageTypes / customTypes 是 legacy-only;image-creation 模式静默置空。
  const imageTypes: ImageTypeKey[] = Array.isArray(f.imageTypes)
    ? f.imageTypes.filter(
        (k): k is ImageTypeKey => typeof k === "string" && isImageTypeKey(k),
      )
    : [];
  const customTypes: string[] = Array.isArray(f.customTypes)
    ? f.customTypes.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  if (
    mode === "product-image" &&
    imageTypes.length === 0 &&
    customTypes.length === 0
  ) {
    parseWarn(
      "reject: product-image mode requires at least one imageType or customType",
    );
    return null;
  }
  // PRD §4.5:"none" 仅 image-creation;legacy 调用方总是发 "zh"/"en"。
  const targetLanguage: ProductImageGenerateForm["targetLanguage"] =
    f.targetLanguage === "en" || f.targetLanguage === "none"
      ? f.targetLanguage
      : "zh";
  const textDensity: ProductImageGenerateForm["textDensity"] | undefined =
    f.textDensity === "none" ||
    f.textDensity === "minimal" ||
    f.textDensity === "normal" ||
    f.textDensity === "rich"
      ? f.textDensity
      : undefined;
  const imageCreationVariant: ProductImageGenerateForm["imageCreationVariant"] =
    f.imageCreationVariant === "general" || f.imageCreationVariant === "ecommerce"
      ? f.imageCreationVariant
      : undefined;
  // 站点选择(平台_国家码):宽松读取,归一与语言推导在 prompt 编译前做。
  const market =
    typeof f.market === "string" && f.market.trim().length > 0
      ? f.market.trim()
      : undefined;

  const promptOverride =
    typeof f.promptOverride === "string" && f.promptOverride.trim().length > 0
      ? f.promptOverride.trim()
      : undefined;

  // ── image-creation 专属字段(软校验:仅保证不把数组/标量塞进对象槽)─────
  const prompt = typeof f.prompt === "string" ? f.prompt : undefined;
  const rawCount = typeof f.count === "number" ? f.count : undefined;
  const count =
    rawCount && Number.isFinite(rawCount)
      ? Math.max(1, Math.min(8, Math.round(rawCount)))
      : undefined;
  // 重新生成按托管 URL 回喂上一帧。仅接受 http(s),防 SSRF/本地文件读取。
  const mainImageUrls: string[] | undefined = Array.isArray(f.mainImageUrls)
    ? (f.mainImageUrls as unknown[]).filter(
        (u): u is string =>
          typeof u === "string" && /^https?:\/\//i.test(u.trim()),
      )
    : undefined;
  const attachedRefsSources: AttachedRefSource[] | undefined = Array.isArray(
    f.attachedRefsSources,
  )
    ? (f.attachedRefsSources as unknown[]).map(
        (s): AttachedRefSource =>
          s === "main" || s === "generated" ? s : "paperclip",
      )
    : undefined;
  const attachedRefsChipNumbers: (number | null)[] | undefined = Array.isArray(
    f.attachedRefsChipNumbers,
  )
    ? (f.attachedRefsChipNumbers as unknown[]).map((n): number | null => {
        if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
        return null;
      })
    : undefined;
  // 预格式化 chip-token(如 "[生成图3-2]" / "[图5]"):只接受严格符合线上
  // 格式的短 token,其余置 null 让 builder 回退,防止注入任意 LLM prompt 文本。
  const attachedRefsChipTokens: (string | null)[] | undefined = Array.isArray(
    f.attachedRefsChipTokens,
  )
    ? (f.attachedRefsChipTokens as unknown[]).map((s): string | null => {
        if (typeof s !== "string") return null;
        const trimmed = s.trim();
        if (trimmed.length === 0 || trimmed.length > 32) return null;
        if (!/^\[(产品图|主图|生成图|图)\d+(-\d+)?\]$/.test(trimmed))
          return null;
        return trimmed;
      })
    : undefined;

  const productInfo =
    f.productInfo &&
    typeof f.productInfo === "object" &&
    !Array.isArray(f.productInfo)
      ? f.productInfo
      : undefined;
  const brandIdentity =
    f.brandIdentity &&
    typeof f.brandIdentity === "object" &&
    !Array.isArray(f.brandIdentity)
      ? f.brandIdentity
      : undefined;

  return {
    projectId: typeof f.projectId === "string" ? f.projectId : undefined,
    mode,
    editMode: f.editMode,
    productName: f.productName as string,
    categoryL1: f.categoryL1 as string,
    categoryL2: f.categoryL2 as string,
    productDescription:
      typeof f.productDescription === "string"
        ? f.productDescription
        : undefined,
    provider: f.provider as ImageProviderId,
    aspectRatio: f.aspectRatio as ProductImageGenerateForm["aspectRatio"],
    customAspectW:
      typeof f.customAspectW === "number" ? f.customAspectW : undefined,
    customAspectH:
      typeof f.customAspectH === "number" ? f.customAspectH : undefined,
    customSizeMode:
      f.customSizeMode === "pixels" || f.customSizeMode === "ratio"
        ? f.customSizeMode
        : undefined,
    resolutionTier,
    resolution: legacyResolution,
    imageTypes,
    customTypes,
    market,
    targetLanguage,
    textDensity,
    imageCreationVariant,
    imageLabelBase:
      typeof f.imageLabelBase === "string" ? f.imageLabelBase : undefined,
    promptOverride,
    prompt,
    displayPrompt:
      typeof f.displayPrompt === "string" ? f.displayPrompt : undefined,
    count,
    mainImageUrls,
    attachedRefsSources,
    attachedRefsChipNumbers,
    attachedRefsChipTokens,
    productInfo,
    brandIdentity,
  };
}

// ─── multipart 文件形状(自有最小接口,避免引入 @types/multer) ───────────────

/** multer(memory storage)解析后的文件;只声明本模块用到的字段。 */
export interface GenerateUploadFile {
  fieldname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
  originalname?: string;
}

export interface GenerateUploadFiles {
  main?: GenerateUploadFile[];
  mainImages?: GenerateUploadFile[];
  detail?: GenerateUploadFile[];
  structure?: GenerateUploadFile[];
  attachedRefs?: GenerateUploadFile[];
}

// ─── 对外契约(源路由响应体投影) ─────────────────────────────────────────────

export interface GeneratedImageSlotView {
  id: number;
  order: number;
  status: "GENERATING";
}

export type GenerateCreateResult =
  | { ok: true; taskId: number; generatedImages: GeneratedImageSlotView[]; localRedraw?: LocalRedrawPlan }
  | { ok: false; status: number; error: string };

interface GenerateTaskItem {
  index: number;
  typeKey: string;
  label: string;
}

/** 校验远程图 URL 可拉取(源 urlToReference 的服务端 fetch;这里只探活,
 *  字节由执行器按同一 URL 拉回)。 */
async function assertUrlFetchable(url: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${resp.status}`);
}

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly imageProject: ImageProjectService,
    private readonly queue: DispatchQueueService,
    private readonly runner: GenerationTaskRunnerService,
    private readonly usage: UsageService,
    private readonly gateway: AiGatewayProvider,
  ) {}

  /** 固定一口价(积分/张):AiGatewayModel.fixedCredits(IMAGE_GENERATION 行),
   *  逻辑 ID 先经 resolveGatewayModel 解析;未配置/查询失败返回 null 不预检。 */
  private loadFixedCredits(provider: string): Promise<Decimal | null> {
    return loadImageGenerationFixedCredits(this.usage, provider);
  }

  async create(
    input: {
      form?: unknown
      files?: GenerateUploadFiles
      /** 仅由后端校验来源图片后传入，不读取前端表单的旧档位。 */
      localRedrawResolutionTier?: LocalRedrawPlan["resolutionTier"]
      portrait?: {
        promptConfig: Prisma.InputJsonObject
        viewConfig?: Prisma.InputJsonValue
        presetOption?: string
      }
    },
    userId: number,
    source: CreationSource = "platform",
  ): Promise<GenerateCreateResult> {
    const form = parseForm(input.form);
    if (!form) {
      return { ok: false, status: 400, error: "Invalid or missing `form` field" };
    }

    // 后端执行器以 GenerationTask 行为真相源,projectId 必填(FE 始终携带)。
    const projectId = Number(form.projectId);
    if (
      typeof form.projectId !== "string" ||
      form.projectId.trim().length === 0 ||
      !Number.isInteger(projectId) ||
      projectId <= 0
    ) {
      return { ok: false, status: 400, error: "`projectId` is required" };
    }

    const project = await this.prisma.imageProject.findUnique({
      where: { id: projectId, userId, source },
      select: { id: true },
    });
    if (!project) return { ok: false, status: 404, error: "项目不存在" };

    const isImageCreation = form.mode === "image-creation";
    const isLocalRedraw = form.editMode === "local-redraw"
    const files = input.files ?? {};
    const detailFile = files.detail?.[0];
    const structureFile = files.structure?.[0];

    // ── 读取 multipart 文件 ─────────────────────────────────────────────
    // CONTRACT: 引用图顺序 [...urlMains, ...fileMains, ...attachedRefs, logo]。
    // 结构化 prompt 的引用图编号(Image 1..N:主图在前,回形针在后)依赖该
    // 顺序,这里与执行器都不可重排。legacy 模式 3 个命名槽(main 必填 +
    // 可选 detail/structure);image-creation 模式多文件 mainImages(可缺省,
    // 回退 legacy main,支持纯文生图)+ 多文件 attachedRefs。
    const attachedFiles = isImageCreation ? (files.attachedRefs ?? []) : [];
    let mainList: GenerateUploadFile[];
    if (isImageCreation) {
      mainList = files.mainImages?.length
        ? files.mainImages
        : files.main?.[0]
          ? [files.main[0]]
          : [];
    } else {
      const mainFile = files.main?.[0];
      if (!mainFile) {
        return {
          ok: false,
          status: 400,
          error: "Main reference image (`main`) is required",
        };
      }
      mainList = [mainFile];
    }

    // URL 主图(重新生成回喂上一帧):源路由在请求期服务端拉取,失败 → 400
    // 同文案;这里只做连通性校验,字节由执行器按 URL 拉回(同地址,同字节)。
    try {
      for (const url of isLocalRedraw ? [] : form.mainImageUrls ?? []) {
        await assertUrlFetchable(url);
      }
    } catch {
      return { ok: false, status: 400, error: "Failed to read uploaded images" };
    }

    // 品牌 LOGO:品牌基因存的是 Spaces URL;源路由拉取失败时静默跳过
    // (非致命,照抄),生成继续(仅少一个 logo 参考)。
    let brandLogoAppended = false;
    let brandLogoUrl: string | undefined;
    if (isImageCreation && !isLocalRedraw) {
      const logoUrl = form.brandIdentity?.logoUrl;
      if (typeof logoUrl === "string" && logoUrl.trim()) {
        try {
          await assertUrlFetchable(logoUrl.trim());
          brandLogoUrl = logoUrl.trim();
          brandLogoAppended = true;
        } catch {
          this.logger.warn(
            `[generate] brand logo fetch failed; generating without it: ${logoUrl}`,
          );
        }
      }
    }

    const mainCount = (form.mainImageUrls?.length ?? 0) + mainList.length;
    const paperclipAttachedCount = attachedFiles.length;
    let localRedraw: LocalRedrawPlan | undefined
    if (isLocalRedraw) {
      if (!(form.promptOverride ?? form.prompt ?? "").trim()) {
        return { ok: false, status: 400, error: "局部重绘必须提供编辑指令" }
      }
      if (mainCount + paperclipAttachedCount < 2) {
        return { ok: false, status: 400, error: "局部重绘必须提供原图和标注图" }
      }
    }

    if (isLocalRedraw) {
      try {
        localRedraw = await prepareLocalRedraw(this.prisma, [
          ...(form.mainImageUrls ?? []), ...mainList.map(file => file.buffer),
          ...attachedFiles.map(file => file.buffer),
        ], this.gateway, form.promptOverride ?? form.prompt ?? "", input.localRedrawResolutionTier)
      } catch (error) {
        if (error instanceof HttpException) return { ok: false, status: error.getStatus(), error: error.message }
        throw error
      }
      form.provider = localRedraw.provider as ImageProviderId
      form.aspectRatio = "custom"
      form.customSizeMode = "pixels"
      form.customAspectW = localRedraw.generationWidth
      form.customAspectH = localRedraw.generationHeight
      form.resolution = `${localRedraw.generationWidth}x${localRedraw.generationHeight}`
      if (localRedraw.providerApplied)
        form.resolutionTier = localRedraw.providerApplied.resolution.toUpperCase() as typeof form.resolutionTier
    }

    // ── Build task items ───────────────────────────────────────────────
    // image-creation:count 张(默认 4);legacy:内置类型在前(稳定顺序),
    // 自定义类型追加 "custom:" 前缀(客户端靠它消歧)。
    const items: GenerateTaskItem[] = [];
    if (isImageCreation) {
      const count = form.count ?? 4;
      for (let i = 0; i < count; i++) {
        items.push({
          index: i,
          typeKey: `${CUSTOM_PREFIX}image-creation:${i}`,
          label: `图 ${i + 1}`,
        });
      }
    } else {
      form.imageTypes.forEach((key, i) => {
        items.push({
          index: i,
          typeKey: key,
          label: IMAGE_TYPE_LABELS[key].zh,
        });
      });
      form.customTypes.forEach((text, i) => {
        items.push({
          index: form.imageTypes.length + i,
          typeKey: `${CUSTOM_PREFIX}${text}`,
          label: text,
        });
      });
    }
    const total = items.length;
    if (total === 0) {
      return {
        ok: false,
        status: 400,
        error: "At least one item to generate is required",
      };
    }

    // 固定一口价预检：模型目录行配置 fixedCredits → 按「单价 × 张数」校验余额
    // （不打折口径，与执行器终态扣费同源）；未配置回落现状不预检。实时读库。
    const fixedCredits = localRedraw
      ? await loadImageGenerationFixedCredits(this.usage, form.provider, LOCAL_REDRAW_CATEGORY)
      : await this.loadFixedCredits(form.provider);
    if (fixedCredits) {
      try {
        await this.usage.assertExactCreditsAffordable(userId, fixedCredits.mul(total));
      } catch (err) {
        return {
          ok: false,
          status: 400,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // ── Compile Task-Level Prompt(分支逐条照源)────────────────────────
    const promptResolution = resolveTargetImageSize({
      aspectRatio: form.aspectRatio,
      customAspectW: form.customAspectW,
      customAspectH: form.customAspectH,
      customSizeMode: form.customSizeMode,
      resolutionTier: form.resolutionTier,
    }).size;
    const mainRefsLabels = (form.mainImageCategories ?? []).slice(0, mainCount);
    const deliveryPlan: DeliveryPlan | null = localRedraw ? null : deliveryPlanForForm(form);

    let taskPrompt = "";
    if (isLocalRedraw) {
      // 通用模板的翻译/文字密度规则会覆盖局部编辑要求，编辑指令必须完整直传。
      taskPrompt = form.promptOverride ?? form.prompt ?? ""
    } else if (isImageCreation) {
      // 站点选择 → 图上文字语言硬性指令:按国家码动态推导(marketplace-language),
      // 解析不出国家回落英文档并记 parseWarn;market 缺省不注入任何站点指令,
      // prompt 输出与现状逐字节一致(等价性录制件不受影响)。
      let marketplaceLanguage: MarketplaceLanguage | undefined;
      if (form.market) {
        marketplaceLanguage = resolveMarketplaceLanguage(form.market);
        if (!marketplaceLanguage) {
          parseWarn(
            `market "${form.market}" unrecognized — on-image text falls back to English`,
          );
          marketplaceLanguage = FALLBACK_MARKETPLACE_LANGUAGE;
        }
      }
      if (isPromptStructuredEnabled()) {
        const effectiveUserBrief =
          typeof form.promptOverride === "string" &&
          form.promptOverride.trim().length > 0
            ? form.promptOverride
            : (form.prompt ?? "");

        const renderLevel = imageCreationRenderLevelForProvider(form.provider);

        // 回形针 refs 按索引与表单数组配对,之后是服务端注入的 brand-logo 槽,
        // 顺序镜像引用图 [...main, ...paperclip, logo] 的 push 顺序。
        const attachedRefsSources: AttachedRefSource[] = [];
        const attachedRefsChipNumbers: (number | null)[] = [];
        const attachedRefsChipTokens: (string | null)[] = [];
        {
          const sources = form.attachedRefsSources ?? [];
          const nums = form.attachedRefsChipNumbers ?? [];
          const toks = form.attachedRefsChipTokens ?? [];
          for (let i = 0; i < paperclipAttachedCount; i++) {
            attachedRefsSources.push(sources[i] ?? "paperclip");
            attachedRefsChipNumbers.push(nums[i] ?? null);
            attachedRefsChipTokens.push(toks[i] ?? null);
          }
          if (brandLogoAppended) {
            attachedRefsSources.push("brand-logo");
            attachedRefsChipNumbers.push(null);
            attachedRefsChipTokens.push(null);
          }
        }

        const built = buildImageCreationPromptStructured(
          {
            prompt: effectiveUserBrief,
            mainRefsCount: mainCount,
            mainRefsLabels,
            attachedRefsCount: attachedRefsSources.length,
            attachedRefsSources,
            attachedRefsChipNumbers,
            attachedRefsChipTokens,
            productInfo: form.productInfo,
            brandIdentity: form.brandIdentity,
            targetLanguage: form.targetLanguage,
            textDensity: form.textDensity,
            imageCreationVariant: form.imageCreationVariant,
            marketplaceLanguage,
            aspectRatio: form.aspectRatio,
            customAspectW: form.customAspectW,
            customAspectH: form.customAspectH,
            customSizeMode: form.customSizeMode,
            resolution: promptResolution,
          },
          { renderLevel },
        );
        taskPrompt = built.prompt;
      } else if (form.promptOverride) {
        taskPrompt = form.promptOverride;
        // 重生成的自定义提示词仍须遵守站点语言；无文字模式不注入文字要求。
        if (marketplaceLanguage && form.targetLanguage !== "none" && form.textDensity !== "none") {
          taskPrompt = `${marketplaceLanguageHead(marketplaceLanguage)}${taskPrompt}${marketplaceLanguageTail(marketplaceLanguage)}`;
        }
      } else {
        taskPrompt = buildImageCreationPrompt({
          prompt: form.prompt ?? "",
          attachedRefsCount: paperclipAttachedCount + (brandLogoAppended ? 1 : 0),
          mainRefsCount: mainCount,
          mainRefsLabels,
          aspectRatio: form.aspectRatio,
          customAspectW: form.customAspectW,
          customAspectH: form.customAspectH,
          resolution: promptResolution,
          targetLanguage: form.targetLanguage,
          textDensity: form.textDensity,
          imageCreationVariant: form.imageCreationVariant,
          marketplaceLanguage,
          productInfo: form.productInfo,
          brandIdentity: form.brandIdentity,
        });
      }
    } else {
      const firstItem = items[0];
      const typeKey = firstItem.typeKey;
      const imageType = typeKey.startsWith(CUSTOM_PREFIX)
        ? typeKey.slice(CUSTOM_PREFIX.length)
        : (typeKey as ImageTypeKey);

      if (form.promptOverride) {
        taskPrompt = form.promptOverride;
      } else {
        // atlas-wan 的 edit-prompt 分支随 B4 direct 退役移除(槽位已下线)。
        taskPrompt = buildImagePrompt({
          centerCrop: deliveryPlan && deliveryPlan.finalizer.fit !== "cover" ? false : undefined,
          productName: form.productName,
          categoryL1: form.categoryL1,
          categoryL2: form.categoryL2,
          productDescription: form.productDescription,
          imageType,
          aspectRatio: form.aspectRatio,
          customAspectW: form.customAspectW,
          customAspectH: form.customAspectH,
          resolution: promptResolution,
          hasDetailImage: Boolean(detailFile),
          hasStructureImage: Boolean(structureFile),
          targetLanguage: form.targetLanguage,
        });
      }
    }

    // ── Upload Reference Images to Spaces ──────────────────────────────
    // 照源:仅文件型主图 + 回形针 refs 上传(顺序 mainList → attachedFiles),
    // 同时充当任务 refImageUrls 快照与执行器引用图源(URL 冻结进
    // executionSpec)。失败非致命:记日志后置空,任务照建(照源行为)。
    let refImageUrls: string[] = [];
    const uploadOne = async (file: GenerateUploadFile): Promise<string> =>
      uploadBytesToSpaces({
        bytes: new Uint8Array(file.buffer),
        mimeType: file.mimetype || "image/png",
        scene: "IMAGE_CREATION_PRODUCT_IMAGE",
        authToken: "",
      });
    try {
      refImageUrls = await Promise.all([
        ...mainList.map(uploadOne),
        ...attachedFiles.map(uploadOne),
      ]);
    } catch (uploadErr) {
      this.logger.error(
        `[generate] failed to upload references to Spaces: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
      );
      if (isLocalRedraw) return { ok: false, status: 502, error: "局部重绘参考图保存失败，请重试" }
      refImageUrls = [];
    }

    // ── 冻结执行规格(执行器消费;deliveryPlan = 显式像素目标的交付计划)──
    const specDraft: GenerationExecutionSpec = {
      kind: "IMAGE_CREATIVE_GENERATE",
      mode: isImageCreation ? "image-creation" : "product-image",
      provider: form.provider,
      modelPublicId: resolveGatewayModel(form.provider) ?? form.provider,
      localRedraw,
      taskPrompt,
      promptResolution,
      form: {
        productName: form.productName,
        categoryL1: form.categoryL1,
        categoryL2: form.categoryL2,
        productDescription: form.productDescription,
        aspectRatio: form.aspectRatio,
        customAspectW: form.customAspectW,
        customAspectH: form.customAspectH,
        customSizeMode: form.customSizeMode,
        resolutionTier: form.resolutionTier,
        resolution: form.resolution,
        targetLanguage: form.targetLanguage,
        hasDetailImage: Boolean(detailFile),
        hasStructureImage: Boolean(structureFile),
      },
      items: items.map((it) => ({
        order: it.index,
        typeKey: it.typeKey,
        imageType: it.typeKey.startsWith(CUSTOM_PREFIX)
          ? it.typeKey.slice(CUSTOM_PREFIX.length)
          : it.typeKey,
      })),
      referenceUrls: [
        ...(form.mainImageUrls ?? []),
        ...refImageUrls.slice(0, mainList.length),
        ...refImageUrls.slice(mainList.length),
        ...(brandLogoAppended && brandLogoUrl ? [brandLogoUrl] : []),
      ],
      mainCount,
      paperclipAttachedCount,
      brandLogoAppended,
      deliveryPlan: deliveryPlan ?? undefined,
    };
    // JSON 往返剥掉 undefined 键,保持 executionSpec 干净可序列化。
    const executionSpec = JSON.parse(JSON.stringify(specDraft)) as GenerationExecutionSpec;

    // ── Register Task(进程内直调,载荷字段与源 createTaskDto 完全一致)──
    let taskRecord: Awaited<ReturnType<ImageProjectService["createTask"]>>;
    try {
      const modelAlias =
        IMAGE_PROVIDER_LABELS[form.provider] ?? String(form.provider);
      // 归档用户 RAW brief 而非编译后的 taskPrompt(该字段回读进任务详情的
      // PROMPT 面板并作为重新生成的兜底 brief):displayPrompt 优先(客户端
      // 自组 wire prompt 时);legacy 模式归档编译稿(模板驱动,无用户手打)。
      const archivedPrompt = isImageCreation
        ? form.displayPrompt !== undefined
          ? form.displayPrompt
          : (form.prompt ?? "")
        : taskPrompt;
      const createTaskDto = {
        presetCategory: "custom",
        model: modelAlias,
        prompt: archivedPrompt,
        language: form.targetLanguage,
        aspectRatio: form.aspectRatio,
        n: total,
        refImageUrls: localRedraw ? executionSpec.referenceUrls : refImageUrls.length ? refImageUrls : undefined,
        // 套图命名基名:随任务落库(imageLabelBase 为兼容层透传字段,
        // 与经 HTTP 白名单过滤后的落库行为一致)。
        ...(form.imageLabelBase ? { imageLabelBase: form.imageLabelBase } : {}),
        status: "GENERATING" as const,
        generatedImages: Array.from({ length: total }).map((_, i) => ({
          order: i,
          status: "GENERATING" as const,
        })),
      };

      const args = [projectId, createTaskDto, userId, source] as const
      taskRecord = localRedraw
        ? await this.imageProject.createTask(...args, {
            executionSpec: executionSpec as unknown as Prisma.InputJsonObject,
            deadlineAt: new Date(Date.now() + GENERATION_DEADLINE_MS),
            portrait: input.portrait ? {
              ...input.portrait,
              promptConfig: {
                ...input.portrait.promptConfig,
                localRedraw: { ...localRedraw },
                model_params: localRedraw.providerApplied ?? { size: `${localRedraw.generationWidth}x${localRedraw.generationHeight}` },
                references: (executionSpec.referenceUrls ?? []).map(url => ({ source_type: "UPLOAD", url })),
              },
            } : undefined,
          })
        : await this.imageProject.createTask(...args)
      if (!localRedraw) await this.prisma.generationTask.update({
        where: { id: taskRecord.id },
        data: {
          executionSpec: executionSpec as unknown as Prisma.InputJsonValue,
          deadlineAt: new Date(Date.now() + GENERATION_DEADLINE_MS),
        },
      });
    } catch (err) {
      // 源路由:注册失败 502 "无法连接后端服务(API_BASE):detail [cause]"。
      // 进程内调用无网络层,保留前缀与状态码,detail 换成进程内错误。
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[generate] failed to register task on backend: ${detail}`,
      );
      return {
        ok: false,
        status: 502,
        error: `无法连接后端服务（in-process）：${detail}`,
      };
    }

    // ── 后台执行(源 after() 的等价物):openai-gpt-image 逐张串行
    //    (settleTasksSequentially),其余每图一个任务(信号量限并发)。──
    const slots = taskRecord.generatedImages; // order asc,与 items 对位
    const imageIds = items.map(
      (it) =>
        slots.find((g) => g.order === it.index && typeof g.id === "number")
          ?.id,
    );
    if (form.provider === "openai-gpt-image") {
      this.queue.enqueue(async () => {
        for (const id of imageIds) {
          if (typeof id === "number") {
            await this.runner.executeGeneratedImage(id);
          }
        }
      });
    } else {
      for (const id of imageIds) {
        if (typeof id === "number") {
          this.queue.enqueue(() => this.runner.executeGeneratedImage(id));
        }
      }
    }

    return {
      ok: true,
      taskId: taskRecord.id,
      ...(localRedraw ? { localRedraw } : {}),
      generatedImages: slots
        .filter((g) => typeof g.id === "number")
        .map((g) => ({
          id: g.id,
          order: g.order,
          status: "GENERATING" as const,
        })),
    };
  }

  /** 取消语义照源 /generate/cancel:无论是否本进程持有执行器,任务都置
   *  CANCELLED(errorMessage "已手动取消");幂等(已终态 → 无操作成功)。
   *  事务 CAS:任务 GENERATING→CANCELLED + cancelRequested=true + 全部
   *  GENERATING 图置 FAILED——晚到的成功被执行器 settle CAS
   *  (WHERE status='GENERATING')挡住,不会复活已取消的图(取消竞态修复)。
   *  非本人/不存在的任务同样静默成功(源路由对 PATCH 失败仅记日志)。 */
  async cancel(
    taskId: number,
    userId: number,
  ): Promise<{ success: boolean; aborted: boolean }> {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId, userId, source: "platform", project: { source: "platform" } },
      select: { id: true },
    });
    if (!task) return { success: true, aborted: false };

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.generationTask.updateMany({
        where: {
          id: taskId,
          status: "GENERATING",
          userId,
          source: "platform",
          project: { source: "platform" },
        },
        data: {
          status: "CANCELLED",
          errorMessage: CANCELLED_MESSAGE,
          cancelRequested: true,
        },
      });
      if (updated.count > 0) {
        await tx.generatedImage.updateMany({
          where: { taskId, status: "GENERATING" },
          data: { status: "FAILED", errorMessage: CANCELLED_MESSAGE },
        });
      }
    });
    // abort 本进程在途执行(源 abortGeneration,可能持有于其它实例)+
    // 上报取消前已成功图的 usage(源 after() 被 abort 后的收尾上报)。
    const aborted = await this.runner.onTaskCancelled(taskId);
    return { success: true, aborted };
  }

  /** 服务端重试(刷新后重试):用任务落库的 executionSpec(参考图 Spaces URL、
   *  编译后 prompt、provider、尺寸)重跑全部 FAILED 图,不依赖浏览器的原始
   *  输入(File 对象跨刷新即丢,原前端重试路径因此报"任务数据已丢失")。
   *  - 仅拒用户主动取消的任务(cancelRequested);全失败聚合成的 CANCELLED
   *    (errorMessage=所有图片生成失败)与 TIMEOUT/SUCCESS 带失败图均可重试;
   *  - 图 FAILED→GENERATING 且 attemptNo/租约清零(认领 CAS 上限 3 次);
   *  - 任务回 GENERATING 并延长 deadlineAt(否则认领即超时);
   *  - 派发复用原路径(openai-gpt-image 串行语义保持),settle 后聚合自然收敛。
   */
  async retryTaskImages(
    taskId: number,
    userId: number,
  ): Promise<
    | {
        ok: true;
        generatedImages: Array<{ id: number; order: number; status: "GENERATING" }>;
      }
    | { ok: false; status: number; error: string }
  > {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      include: { generatedImages: { where: { source: "platform" } } },
    });
    if (!task || task.userId !== userId) {
      return { ok: false, status: 404, error: "任务不存在" };
    }
    if (task.cancelRequested) {
      return {
        ok: false,
        status: 400,
        error: "任务已手动取消，无法重试，请重新发起",
      };
    }
    const failed = task.generatedImages
      .filter((g) => g.status === "FAILED")
      .sort((a, b) => a.order - b.order);
    if (failed.length === 0) {
      return { ok: false, status: 400, error: "没有可重试的失败图片" };
    }

    await this.prisma.$transaction([
      this.prisma.generatedImage.updateMany({
        where: { taskId, status: "FAILED" },
        data: {
          status: "GENERATING",
          errorMessage: null,
          attemptNo: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      this.prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: "GENERATING",
          errorMessage: null,
          deadlineAt: new Date(Date.now() + GENERATION_DEADLINE_MS),
        },
      }),
      ...(task.type === "PORTRAIT" && (task.executionSpec as GenerationExecutionSpec | null)?.localRedraw
        ? [this.prisma.imageProject.updateMany({ where: { id: task.projectId, status: { not: "ARCHIVED" }, deletedAt: null }, data: { status: "GENERATING" } })]
        : []),
    ]);

    const provider =
      (task.executionSpec as { provider?: string } | null)?.provider ?? "";
    if (provider === "openai-gpt-image") {
      this.queue.enqueue(async () => {
        for (const g of failed) {
          await this.runner.executeGeneratedImage(g.id);
        }
      });
    } else {
      for (const g of failed) {
        this.queue.enqueue(() => this.runner.executeGeneratedImage(g.id));
      }
    }

    return {
      ok: true,
      generatedImages: failed.map((g) => ({
        id: g.id,
        order: g.order,
        status: "GENERATING" as const,
      })),
    };
  }
}
