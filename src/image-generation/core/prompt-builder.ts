// src/server/image/prompt-builder.ts
//
// Preset prompt composer for the 商品图生成 flow. Each built-in ImageTypeKey
// maps to a fixed template aligned with the product team spec (see docs
// table). The template language mirrors `targetLanguage` — Chinese targets
// ship a Chinese prompt, English targets ship an English prompt. Optional
// slots (color/material/description/structure-image) are gracefully omitted
// when absent so we never emit dangling particles.
//
// Why fully bilingual instead of a single Chinese prompt with an English
// tail directive? Image generators bias on-image text toward the dominant
// language of the prompt; a Chinese-heavy prompt with an English instruction
// tail routinely renders Chinese glyphs anyway. Keeping the entire prompt in
// the target language plus bracketing directives (head + tail) is what
// actually forces compliance.

import {
  marketplaceLanguageHead,
  marketplaceLanguageTail,
  type MarketplaceLanguage,
} from "../../common/utils/marketplace-language";
import { centerCropSafeRatio } from "../../common/utils/image-crop-safe-prompt";
import type { ImageCreationRenderLevel } from "./image-creation-render-level";
import {
  IMAGE_TYPE_LABELS,
  ON_IMAGE_TEXT_COUNT_RANGES,
  type AspectRatio,
  type AttachedRefSource,
  type BrandIdentitySnapshot,
  type ImageTypeKey,
  type ProductInfoSnapshot,
  type TargetLanguage,
  type TextDensity,
} from "./types";

export interface BuildImagePromptInput {
  /** 补边交付时关闭安全构图，保留既有商品占比。 */
  centerCrop?: boolean;
  productName: string;
  categoryL1: string;
  categoryL2: string;
  productDescription?: string;
  /** Optional — if extract ever surfaces it we use it verbatim in prompts. */
  color?: string;
  /** Optional — same as color. */
  material?: string;
  /** Either a known ImageTypeKey or a free-text custom prompt. */
  imageType: ImageTypeKey | string;
  /** Additional custom prompts the user wants applied on top. */
  customTypes?: string[];
  /** UI aspect ratio token — flows through into the prompt. */
  aspectRatio?: AspectRatio | string;
  /** Custom aspect numerator / denominator (used only when aspectRatio === "custom"). */
  customAspectW?: number;
  customAspectH?: number;
  /** Resolution string (e.g. "1024x1024"). */
  resolution?: string;
  /** True when the submission included a 细节纹理图 (图 2). */
  hasDetailImage?: boolean;
  /** True when the submission included a 结构 / 背面图 (图 3). */
  hasStructureImage?: boolean;
  /** Language for the entire prompt AND any rendered on-image text.
   *  Defaults to Chinese. */
  targetLanguage?: TargetLanguage;
}

function isImageTypeKey(key: string): key is ImageTypeKey {
  return Object.prototype.hasOwnProperty.call(IMAGE_TYPE_LABELS, key);
}

function categoryText(l1: string, l2: string): string {
  const left = l1.trim();
  const right = l2.trim();
  if (left && right) return `${left} ${right}`;
  return left || right || "";
}

function colorMaterialZh(color?: string, material?: string): string {
  const c = color?.trim();
  const m = material?.trim();
  if (c && m) return `${c} 色 ${m} 材质`;
  if (c) return `${c} 色`;
  if (m) return `${m} 材质`;
  return "";
}

function colorMaterialEn(color?: string, material?: string): string {
  const c = color?.trim();
  const m = material?.trim();
  if (c && m) return `${c} color, ${m} material`;
  if (c) return `${c} color`;
  if (m) return `${m} material`;
  return "";
}

function resolveRatio(
  aspectRatio?: AspectRatio | string,
  customAspectW?: number,
  customAspectH?: number,
): string {
  const a = aspectRatio?.toString().trim();
  if (!a) return "1:1";
  if (a === "custom") {
    if (customAspectW && customAspectH) return `${customAspectW}:${customAspectH}`;
    return "1:1";
  }
  return a;
}

function sideAngle(key: ImageTypeKey): number | null {
  if (key === "side_30") return 30;
  if (key === "side_45") return 45;
  if (key === "side_90") return 90;
  return null;
}

interface Ctx {
  centerCrop?: boolean;
  name: string;
  category: string;
  colorMaterial: string;
  otherInfo: string;
  ratio: string;
  resolution: string;
  hasDetail: boolean;
  hasStructure: boolean;
  extras: string;
  lang: TargetLanguage;
}

/** Joins CN fragments with "，", skipping blanks, stripping trailing CN/EN
 *  sentence punctuation on each fragment so we never emit "...。，..." . */
function joinCn(fragments: (string | undefined | null)[]): string {
  return fragments
    .map((f) => (f ?? "").trim().replace(/[，。！？.!?]+$/u, ""))
    .filter((f) => f.length > 0)
    .join("，");
}

/** English analogue — joins with ", " and strips trailing punctuation. */
function joinEn(fragments: (string | undefined | null)[]): string {
  return fragments
    .map((f) => (f ?? "").trim().replace(/[，。！？.!?]+$/u, ""))
    .filter((f) => f.length > 0)
    .join(", ");
}

function extrasClauseZh(extras: string): string {
  return extras ? `，附加要求：${extras}` : "";
}
function extrasClauseEn(extras: string): string {
  return extras ? `. Additional requirements: ${extras}` : "";
}

// ── Directives ──────────────────────────────────────────────────────────────
// Bracketing the core prompt with a HEAD + TAIL language rule is what actually
// makes models stop silently rendering the wrong script. Head primes the model;
// tail is the last thing it reads before emitting.

type CountedDensity = "minimal" | "normal" | "rich";

/** Which image-creation page submitted the prompt. 电商创作 ("ecommerce") uses
 *  structural marketing composition guidance for the text-density directive;
 *  通用创作 ("general") keeps the legacy quantitative word-count band. */
export type ImageCreationVariant = "general" | "ecommerce";

function rangeFor(lang: "en" | "zh", density: CountedDensity) {
  return ON_IMAGE_TEXT_COUNT_RANGES[lang][density];
}

/** Density-aware language directive at the HEAD of the prompt. The density
 *  axis (none / minimal / normal / rich) is orthogonal to the language axis
 *  (zh / en / none): density "none" overrides language entirely (no text at
 *  all), while minimal / normal / rich layer a quantitative on-image text
 *  count range on top of the language constraint (see
 *  ON_IMAGE_TEXT_COUNT_RANGES for the exact bounds).
 *
 *  Legacy callers (product-image / image-to-image) don't pass density; the
 *  caller-side default is "normal", which now adds a count range hint — for
 *  those flows this is purely additive (their previous prompts had no count
 *  constraint at all). */
function headDirective(lang: TargetLanguage, density: TextDensity = "normal"): string {
  // No-text branch — universal English directive (most reliable for image
  // models). Either axis being "none" forces this path.
  if (lang === "none" || density === "none") {
    return "STRICT RULE: do NOT render any text, captions, labels, annotations, callouts, dimension numbers, brand wordmarks, stickers, or any glyphs of any kind in the output image. The image must be entirely text-free in every language and every script. ";
  }

  if (lang === "en") {
    const base =
      "LANGUAGE=EN. STRICT RULE: Any text, captions, annotations, labels, callouts, dimension numbers with units, brand words, or stickers rendered in the output image MUST be written in English only. Do NOT render any Chinese, Japanese, Korean, Cyrillic, or other non-Latin characters in the image. ";
    const r = rangeFor("en", density);
    if (density === "minimal") {
      return `${base}DENSITY=MINIMAL: total on-image English text MUST be ${r.min}-${r.max} ${r.unit} (count every standalone word, including labels and short callouts). Use at most 1-2 short labels; prefer purely visual storytelling over text. `;
    }
    if (density === "rich") {
      return `${base}DENSITY=RICH: total on-image English text MUST be ${r.min}-${r.max} ${r.unit} (count every standalone word). Use feature labels, dimensions, short callouts, and brief descriptive lines as appropriate to the scene. `;
    }
    return `${base}DENSITY=NORMAL: total on-image English text MUST be ${r.min}-${r.max} ${r.unit} (count every standalone word). Use a moderate number of short labels and callouts — neither sparse nor crowded. `;
  }

  // zh
  const base =
    "语言=简体中文。硬性要求：图中出现的所有文字、标题、标注、尺寸标注、单位、卖点文字、贴纸、品牌词等全部必须使用简体中文，严禁出现英文、日文、韩文或其他外语字符。";
  const r = rangeFor("zh", density);
  if (density === "minimal") {
    return `${base}文字密度=极少：图中中文字符总量必须为 ${r.min}-${r.max} ${r.unitZh}（含所有标签、卖点、标注，每一个汉字计 1）；至多渲染 1-2 个简短中文标签，优先以纯视觉表达。`;
  }
  if (density === "rich") {
    return `${base}文字密度=丰富：图中中文字符总量必须为 ${r.min}-${r.max} ${r.unitZh}（含所有标签、卖点、标注，每一个汉字计 1）；按场景需要铺开功能标注、尺寸数据、卖点说明、简短描述等。`;
  }
  return `${base}文字密度=常规：图中中文字符总量必须为 ${r.min}-${r.max} ${r.unitZh}（含所有标签、卖点、标注，每一个汉字计 1）；保持适中的标签与简短卖点说明，不空白也不堆砌。`;
}

/** Image-creation variant of `headDirective`. The on-page EN/中文 selector
 *  was removed (2026-05-20); the language of any rendered on-image text now
 *  follows whatever the user writes in their prompt, defaulting to English
 *  when the brief is silent — UNLESS a marketplace site was selected
 *  (`marketplace`): then the site's marketplace language takes strict
 *  precedence (dynamically derived from the site's country code, see
 *  common/utils/marketplace-language), overriding both the brief-following
 *  rule and the legacy zh arm, so a Chinese brief still yields on-image copy
 *  in the site's language.
 *
 *  The density directive shape depends on `variant`:
 *    - `"ecommerce"` (电商创作, default) — structural composition guidance
 *      (headline / subheading / feature badges), tuned for marketing imagery.
 *    - `"general"`   (通用创作) — the legacy quantitative word-count band; left
 *      unchanged so general creation behaves exactly as before.
 *
 *  Legacy lang === "zh" (only reachable via persisted task records pre-dating
 *  the selector removal) routes through the strict directive so existing zh
 *  snapshot tests stay green. New submissions always feed lang === "en". */
function headDirectiveImageCreation(
  lang: TargetLanguage,
  density: TextDensity = "normal",
  variant: ImageCreationVariant = "ecommerce",
  marketplace?: MarketplaceLanguage,
): string {
  if (lang === "none" || density === "none") {
    return headDirective(lang, density);
  }
  if (lang === "zh" && !marketplace) {
    return headDirective(lang, density);
  }
  const base = marketplace
    ? marketplaceLanguageHead(marketplace)
    : "LANGUAGE: follow whatever language the user's brief uses for any text shown in the image; if the brief does not specify, default to English. ";

  // 通用创作 — keep the legacy word-count directive untouched.
  if (variant === "general") {
    const r = rangeFor("en", density);
    if (density === "minimal") {
      return `${base}DENSITY=MINIMAL: total on-image text MUST be ${r.min}-${r.max} ${r.unit} (or an equivalent volume in the chosen language); use at most 1-2 short labels and prefer purely visual storytelling over text. `;
    }
    if (density === "rich") {
      return `${base}DENSITY=RICH: total on-image text MUST be ${r.min}-${r.max} ${r.unit} (or an equivalent volume in the chosen language); use feature labels, dimensions, short callouts, and brief descriptive lines as appropriate to the scene. `;
    }
    return `${base}DENSITY=NORMAL: total on-image text MUST be ${r.min}-${r.max} ${r.unit} (or an equivalent volume in the chosen language); use a moderate number of short labels and callouts — neither sparse nor crowded. `;
  }

  // 电商创作 — structural composition guidance.
  if (density === "minimal") {
    return `${base}DENSITY=MINIMAL: The image MUST contain ONLY ONE single primary marketing headline. DO NOT add any dense feature cards, labels, or secondary callout boxes. The layout should be extremely clean. If the reference image naturally includes a very brief single-line subheading, it may be retained loosely, but avoid any additional text blocks. `;
  }
  if (density === "rich") {
    return `${base}DENSITY=RICH: The image MUST contain ONE main headline, ONE subheading, AND roughly 4 to 6 detailed feature labels, specification blocks, or callouts. The text layout should be dense, informative, and rich. The descriptive content within each label is flexible—it may consist of just the core parameter, or include a short explanatory subtitle—giving the model freedom to match the visual rhythm of the reference. `;
  }
  return `${base}DENSITY=NORMAL: The image MUST contain ONE main headline and EITHER one subheading OR roughly 2 to 3 concise feature badges/cards. The layout should be moderate and uncrowded. The internal text of these badges can be either a short keyword or a slightly longer descriptive line, letting the model adapt naturally to the reference composition. `;
}

function tailDirectiveImageCreation(
  lang: TargetLanguage,
  density: TextDensity = "normal",
  variant: ImageCreationVariant = "ecommerce",
  marketplace?: MarketplaceLanguage,
): string {
  if (lang === "none" || density === "none") {
    return tailDirective(lang, density);
  }
  if (lang === "zh" && !marketplace) {
    return tailDirective(lang, density);
  }

  // 站点选定 → 商城语言复查指令(与 head 同源);否则沿用"跟随提示词语言"。
  const languageClause = marketplace
    ? marketplaceLanguageTail(marketplace)
    : " Final reminder: any rendered glyphs must follow the language the user's brief specifies; if the brief is silent, render English.";

  // 通用创作 — keep the legacy word-count re-check untouched.
  if (variant === "general") {
    const r = rangeFor("en", density);
    return `${languageClause} Re-check before finalising: total on-image text count must land within ${r.min}-${r.max} ${r.unit} — not below ${r.min}, not above ${r.max} (or an equivalent volume in the chosen language).`;
  }

  // 电商创作 — structural re-check that mirrors the head directive.
  const recheck =
    density === "minimal"
      ? "keep exactly ONE primary headline and add no feature cards, labels, or secondary callout boxes"
      : density === "rich"
        ? "keep ONE main headline, ONE subheading, and roughly 4 to 6 feature labels / specification blocks / callouts for a dense, informative layout"
        : "keep ONE main headline plus EITHER one subheading OR roughly 2 to 3 concise feature badges — moderate and uncrowded";
  return `${languageClause} Re-check before finalising: ${recheck}.`;
}

function tailDirective(lang: TargetLanguage, density: TextDensity = "normal"): string {
  if (lang === "none" || density === "none") {
    return " Final reminder: the image must contain zero rendered text. Treat every wordmark, label, or caption as forbidden — render none of them.";
  }
  if (lang === "en") {
    const r = rangeFor("en", density);
    const base =
      " Final reminder: every glyph rendered in the output image must be English; reject any Chinese characters even if the source product description contains them.";
    return `${base} Re-check before finalising: total on-image word count must land within ${r.min}-${r.max} ${r.unit} — not below ${r.min}, not above ${r.max}.`;
  }
  const r = rangeFor("zh", density);
  const base =
    "最后提醒：图中渲染的每一个字符都必须是简体中文，即使产品描述中包含英文也要翻译成中文后再渲染到图中，不得直接保留英文字符。";
  return `${base}定稿前再次检查：图中中文字符总数必须落在 ${r.min}-${r.max} ${r.unitZh} 区间内，不少于 ${r.min}、不多于 ${r.max}。`;
}

// ── Chinese built-in templates ──────────────────────────────────────────────

function buildBuiltInZh(key: ImageTypeKey, ctx: Ctx): string {
  const head = joinCn([
    "纯白色背景 (#FFFFFF)",
    ctx.name,
    ctx.colorMaterial,
    ctx.category,
    ctx.otherInfo,
  ]);
  const tail = `${ctx.ratio} 比例，${ctx.resolution} 分辨率`;

  switch (key) {
    case "main_white_front": {
      const body = joinCn([
        head,
        ctx.centerCrop ? "产品正面居中，四周预留可裁剪背景" : "产品正面居中，占画面 85%",
        "无文字无水印无阴影",
        "专业商业摄影，柔和均匀布光，高清细节",
        tail,
      ]);
      return `${body}。主要参考图 1 还原正面${extrasClauseZh(ctx.extras)}。`;
    }
    case "side_30":
    case "side_45":
    case "side_90": {
      const angle = sideAngle(key)!;
      const body = joinCn([
        head,
        `产品 ${angle} 度侧面角度`,
        "展示立体感和厚度",
        "专业商拍光线，突出材质和工艺细节",
        tail,
      ]);
      const ref = ctx.hasStructure
        ? "参考提供的“结构/背面图”还原真实侧面细节"
        : "基于图 1 合理推断，保持产品主体一致";
      return `${body}。${ref}${extrasClauseZh(ctx.extras)}。`;
    }
    case "top_down": {
      const body = joinCn([
        head,
        ctx.centerCrop ? "俯视产品视角，产品居中，四周预留可裁剪背景" : "俯视产品视角，占画面 85%",
        "无文字无水印无阴影",
        "专业商业摄影，柔和均匀布光，高清细节",
        tail,
      ]);
      const ref = ctx.hasStructure
        ? "优先参考提供的“结构/背面图”中的俯视/顶部特征"
        : "以图 1 主体为准合理推断俯视造型";
      return `${body}。${ref}${extrasClauseZh(ctx.extras)}。`;
    }
    case "scene": {
      const body = joinCn([
        `${ctx.name} 在真实使用场景中`,
        `根据「${ctx.category || "该类目"}」挑选合适的真实使用场景`,
        ctx.colorMaterial,
        ctx.category,
        ctx.otherInfo,
        "产品清晰可辨，自然光线，生活化氛围",
        "核心卖点基于产品描述自动挑选 3 个亮点呈现",
        tail,
      ]);
      return `${body}。产品主体严格参考图 1，场景自由发挥${extrasClauseZh(ctx.extras)}。`;
    }
    case "size_annotation": {
      const body = joinCn([
        ctx.name,
        ctx.colorMaterial,
        ctx.category,
        ctx.otherInfo,
        "旁放置参照物（手 / 硬币 / 尺子）",
        "标注关键尺寸线和数字",
        "白底背景，清晰简洁的信息图风格",
        tail,
      ]);
      const ref = ctx.hasStructure
        ? "标注的尺寸数据必须来自提供的“尺码参考图”"
        : "使用常见行业尺寸估计";
      return `${body}。${ref}${extrasClauseZh(ctx.extras)}。`;
    }
    case "selling_point": {
      const body = joinCn([
        `${ctx.name} 产品图`,
        ctx.colorMaterial,
        ctx.category,
        ctx.otherInfo,
        "从产品描述中挑选 3 个最关键卖点并标注",
        "箭头指向对应位置",
        "简洁信息图设计，品牌感",
        tail,
      ]);
      return `${body}。产品主体严格参考图 1${extrasClauseZh(ctx.extras)}。`;
    }
    case "detail_closeup": {
      const detailPhrase = ctx.colorMaterial
        ? `${ctx.colorMaterial} 的纹理 / 按钮 / 接口 / 缝线等工艺细节`
        : "纹理 / 按钮 / 接口 / 缝线等工艺细节";
      const body = joinCn([
        `${ctx.name} 关键细节微距特写`,
        detailPhrase,
        ctx.category,
        ctx.otherInfo,
        "浅景深，专业微距摄影光线",
        tail,
      ]);
      const ref = ctx.hasDetail
        ? "必须 100% 还原提供的“细节纹理图”中的纹理 / 接口 / 按钮真实细节"
        : "基于图 1 主体合理放大推断细节";
      return `${body}。${ref}${extrasClauseZh(ctx.extras)}。`;
    }
    case "packaging": {
      const body = joinCn([
        `${ctx.name} 及所有配件俯拍平铺 (Flat Lay)`,
        ctx.colorMaterial ? `${ctx.colorMaterial} 的主产品居中` : "主产品居中",
        ctx.category,
        ctx.otherInfo,
        "白底，整齐排列展示开箱全部内容",
        "每个配件之间留有间距",
        tail,
      ]);
      return `${body}。主产品以图 1 为准${extrasClauseZh(ctx.extras)}。`;
    }
  }
}

function buildCustomZh(customText: string, ctx: Ctx): string {
  const trimmed = customText.trim();
  const body = joinCn([
    ctx.name,
    ctx.colorMaterial,
    ctx.category,
    ctx.otherInfo,
    `风格：${trimmed || "自定义"}`,
    `${ctx.ratio} 比例，${ctx.resolution} 分辨率`,
  ]);
  return `${body}。产品主体严格参考图 1${extrasClauseZh(ctx.extras)}。`;
}

// ── English built-in templates ──────────────────────────────────────────────

function buildBuiltInEn(key: ImageTypeKey, ctx: Ctx): string {
  const head = joinEn([
    "Pure white background (#FFFFFF)",
    ctx.name,
    ctx.colorMaterial,
    ctx.category,
    ctx.otherInfo,
  ]);
  const tail = `aspect ratio ${ctx.ratio}, ${ctx.resolution} resolution`;

  switch (key) {
    case "main_white_front": {
      const body = joinEn([
        head,
        ctx.centerCrop
          ? "product facing forward, centered with background space on all sides for cropping"
          : "product facing forward, centered and filling 85% of the frame",
        "no text, no watermark, no shadows",
        "professional commercial photography, soft even lighting, crisp high-resolution details",
        tail,
      ]);
      return `${body}. Reference image 1 to reproduce the front view${extrasClauseEn(ctx.extras)}.`;
    }
    case "side_30":
    case "side_45":
    case "side_90": {
      const angle = sideAngle(key)!;
      const body = joinEn([
        head,
        `product at a ${angle}-degree side angle`,
        "show three-dimensional form and thickness",
        "professional studio lighting that emphasises material and craftsmanship",
        tail,
      ]);
      const ref = ctx.hasStructure
        ? "Reference the provided 'structure / back view' image to reproduce accurate side details"
        : "Infer reasonably from image 1, keeping the main subject consistent";
      return `${body}. ${ref}${extrasClauseEn(ctx.extras)}.`;
    }
    case "top_down": {
      const body = joinEn([
        head,
        ctx.centerCrop
          ? "top-down overhead view, product centered with background space on all sides for cropping"
          : "top-down overhead view, product filling 85% of the frame",
        "no text, no watermark, no shadows",
        "professional commercial photography, soft even lighting, crisp high-resolution details",
        tail,
      ]);
      const ref = ctx.hasStructure
        ? "Prefer the provided 'structure / back view' image for top-down / surface features"
        : "Infer top-down shape from the main subject in image 1";
      return `${body}. ${ref}${extrasClauseEn(ctx.extras)}.`;
    }
    case "scene": {
      const body = joinEn([
        `${ctx.name} shown in a real-life use-case scenario`,
        `choose an appropriate real-world setting for the "${ctx.category || "this category"}" category`,
        ctx.colorMaterial,
        ctx.category,
        ctx.otherInfo,
        "product clearly identifiable, natural lighting, lifestyle atmosphere",
        "surface 3 core selling points automatically inferred from the description",
        tail,
      ]);
      return `${body}. Reference image 1 strictly for the product, the scene itself can be creative${extrasClauseEn(ctx.extras)}.`;
    }
    case "size_annotation": {
      const body = joinEn([
        ctx.name,
        ctx.colorMaterial,
        ctx.category,
        ctx.otherInfo,
        "place a scale reference next to the product (hand / coin / ruler)",
        "annotate key dimension lines and numbers",
        "white background, clean minimalist infographic style",
        tail,
      ]);
      const ref = ctx.hasStructure
        ? "Annotated dimension numbers must come from the provided 'size chart' image"
        : "Use common industry size estimates";
      return `${body}. ${ref}${extrasClauseEn(ctx.extras)}.`;
    }
    case "selling_point": {
      const body = joinEn([
        `${ctx.name} product image`,
        ctx.colorMaterial,
        ctx.category,
        ctx.otherInfo,
        "annotate the 3 most critical selling points inferred from the description",
        "arrows pointing to the corresponding locations",
        "clean infographic design, on-brand feel",
        tail,
      ]);
      return `${body}. Reference image 1 strictly for the product${extrasClauseEn(ctx.extras)}.`;
    }
    case "detail_closeup": {
      const detailPhrase = ctx.colorMaterial
        ? `${ctx.colorMaterial} texture / buttons / interfaces / stitching and craftsmanship details`
        : "texture / buttons / interfaces / stitching and craftsmanship details";
      const body = joinEn([
        `${ctx.name} macro close-up of key details`,
        detailPhrase,
        ctx.category,
        ctx.otherInfo,
        "shallow depth of field, professional macro lighting",
        tail,
      ]);
      const ref = ctx.hasDetail
        ? "Must 100% faithfully reproduce the texture / interface / buttons shown in the provided 'detail texture' image"
        : "Zoom in reasonably from the main subject in image 1";
      return `${body}. ${ref}${extrasClauseEn(ctx.extras)}.`;
    }
    case "packaging": {
      const body = joinEn([
        `${ctx.name} and every accessory shot top-down as a flat lay`,
        ctx.colorMaterial
          ? `${ctx.colorMaterial} main product centered`
          : "main product centered",
        ctx.category,
        ctx.otherInfo,
        "white background, tidy arrangement displaying the full unboxing contents",
        "spacing kept between each accessory",
        tail,
      ]);
      return `${body}. The main product must match image 1${extrasClauseEn(ctx.extras)}.`;
    }
  }
}

function buildCustomEn(customText: string, ctx: Ctx): string {
  const trimmed = customText.trim();
  const body = joinEn([
    ctx.name,
    ctx.colorMaterial,
    ctx.category,
    ctx.otherInfo,
    `style: ${trimmed || "custom"}`,
    `aspect ratio ${ctx.ratio}, ${ctx.resolution} resolution`,
  ]);
  return `${body}. Reference image 1 strictly for the product${extrasClauseEn(ctx.extras)}.`;
}

// ── Wan (ZQ-Image-Spicy) edit-style prompts ──────────────────────────────────────
//
// Wan-2.7-Pro is an image-EDIT model — prompts should describe the change
// to apply to the reference, not a full scene from scratch. The generic
// buildImagePrompt output (long templates, "reference image 1/2/3", dual
// head+tail language directives) confuses wan and it falls back to plain
// text-to-image, ignoring the reference entirely.
//
// This builder emits a short "Based on the reference image, [edit]"-shaped
// instruction per imageType. No language strict-rules — wan handles zh/en
// natively. Single-slot references only (wan takes one image_url), so we
// don't mention 图 2 / 图 3 even when the caller uploaded them.

function wanZhForType(key: ImageTypeKey, ctx: Ctx): string {
  const subjectBits = joinCn([ctx.name, ctx.colorMaterial, ctx.category, ctx.otherInfo]);
  const subject = subjectBits ? `（主体：${subjectBits}）` : "";
  switch (key) {
    case "main_white_front":
      return `基于参考图，将产品调整为正面视角，居中占画面 85%，背景替换为纯白 #FFFFFF，去除原背景和阴影。保持产品主体、颜色、材质与参考图完全一致${subject}。专业商拍光线，无文字无水印。`;
    case "side_30":
    case "side_45":
    case "side_90": {
      const angle = sideAngle(key)!;
      return `基于参考图，将产品视角调整为 ${angle} 度侧面，展现立体感与厚度。保持产品主体、颜色、材质与参考图一致${subject}。纯白 #FFFFFF 背景，专业商拍光线。`;
    }
    case "top_down":
      return `基于参考图，将产品视角调整为俯视 / 顶视角，居中占画面 85%。保持产品主体、颜色、材质一致${subject}。纯白 #FFFFFF 背景，柔和均匀布光。`;
    case "scene":
      return `基于参考图，将该产品放入真实使用场景中，场景风格需贴合类目${
        ctx.category ? `「${ctx.category}」` : ""
      }。严格保持产品主体、颜色、材质与参考图一致${subject}。自然光线，生活化氛围。`;
    case "size_annotation":
      return `基于参考图，生成一张带尺寸标注的产品图：产品置于纯白背景中心，旁边放置参照物（手 / 硬币 / 尺子），标注关键尺寸线和数字。保持产品主体与参考图一致${subject}。清晰简洁的信息图风格。`;
    case "selling_point":
      return `基于参考图，生成一张营销卖点图：产品主体保持与参考图一致${subject}，在周围用箭头和简短文字标注 3 个最关键的卖点。简洁信息图风格，品牌感。`;
    case "detail_closeup":
      return `基于参考图，生成一张关键细节的微距特写：聚焦纹理、按钮、接口、缝线等工艺细节${
        ctx.colorMaterial ? `（${ctx.colorMaterial}）` : ""
      }。浅景深，专业微距光线。`;
    case "packaging":
      return `基于参考图，将产品及所有配件以俯视平铺 (Flat Lay) 排列在纯白背景上，主产品居中，配件之间留有间距，整齐展示开箱全部内容。保持主产品与参考图一致${subject}。`;
  }
}

function wanEnForType(key: ImageTypeKey, ctx: Ctx): string {
  const subjectBits = joinEn([ctx.name, ctx.colorMaterial, ctx.category, ctx.otherInfo]);
  const subject = subjectBits ? ` (subject: ${subjectBits})` : "";
  switch (key) {
    case "main_white_front":
      return `Based on the reference image, adjust the product to a front-facing view, centered and filling 85% of the frame. Replace the background with pure white #FFFFFF and remove any original background or shadows. Keep the product's identity, color and material exactly as in the reference${subject}. Professional commercial lighting, no text, no watermark.`;
    case "side_30":
    case "side_45":
    case "side_90": {
      const angle = sideAngle(key)!;
      return `Based on the reference image, rotate the product to a ${angle}-degree side angle, showing three-dimensional form and thickness. Keep the product's identity, color and material identical to the reference${subject}. Pure white #FFFFFF background, professional studio lighting.`;
    }
    case "top_down":
      return `Based on the reference image, change the viewpoint to a top-down overhead view, product centered and filling 85% of the frame. Keep the product's identity, color and material consistent${subject}. Pure white #FFFFFF background, soft even lighting.`;
    case "scene":
      return `Based on the reference image, place the same product in a real-life lifestyle scene suitable for the${
        ctx.category ? ` "${ctx.category}"` : ""
      } category. Preserve the product's identity, color and material exactly as in the reference${subject}. Natural lighting, lifestyle atmosphere.`;
    case "size_annotation":
      return `Based on the reference image, produce a dimension-annotated product shot: product centered on a pure white background with a scale reference nearby (hand, coin, or ruler), and annotated measurement lines with numbers. Keep the product consistent with the reference${subject}. Clean infographic style.`;
    case "selling_point":
      return `Based on the reference image, create a marketing graphic that keeps the product identical to the reference${subject} and annotates 3 key selling points with arrows and short labels pointing to the corresponding parts. Clean infographic design, on-brand.`;
    case "detail_closeup":
      return `Based on the reference image, produce a macro close-up focused on key craftsmanship details (texture, buttons, interfaces, stitching)${
        ctx.colorMaterial ? ` (${ctx.colorMaterial})` : ""
      }. Shallow depth of field, professional macro lighting.`;
    case "packaging":
      return `Based on the reference image, arrange the product and all accessories as a top-down flat lay on a pure white background with the main product centered and spacing between accessories. Keep the main product consistent with the reference${subject}.`;
  }
}

function wanCustomZh(customText: string, ctx: Ctx): string {
  const trimmed = customText.trim();
  const subjectBits = joinCn([ctx.name, ctx.colorMaterial, ctx.category, ctx.otherInfo]);
  const subject = subjectBits ? `（主体：${subjectBits}）` : "";
  return `基于参考图，按以下要求调整：${trimmed || "自定义"}。保持产品主体、颜色、材质与参考图一致${subject}。`;
}

function wanCustomEn(customText: string, ctx: Ctx): string {
  const trimmed = customText.trim();
  const subjectBits = joinEn([ctx.name, ctx.colorMaterial, ctx.category, ctx.otherInfo]);
  const subject = subjectBits ? ` (subject: ${subjectBits})` : "";
  return `Based on the reference image, apply: ${trimmed || "custom"}. Keep the product's identity, color and material identical to the reference${subject}.`;
}

/**
 * ZQ-Image-Spicy (Wan-2.7-Pro) edit prompt. Use this INSTEAD of buildImagePrompt
 * when the target provider is wan — edit-style wording + single-slot
 * reference semantics + no language-strict wrappers.
 */
export function buildWanEditPrompt(input: BuildImagePromptInput): string {
  const lang: TargetLanguage = input.targetLanguage === "en" ? "en" : "zh";
  const name = (input.productName || "").trim() || (lang === "en" ? "the product" : "该产品");
  const category = categoryText(input.categoryL1, input.categoryL2);
  const colorMaterial =
    lang === "en"
      ? colorMaterialEn(input.color, input.material)
      : colorMaterialZh(input.color, input.material);
  const otherInfo = (input.productDescription || "").trim();
  const ratio = resolveRatio(input.aspectRatio, input.customAspectW, input.customAspectH);
  const resolution = (input.resolution || "").trim() || "1024x1024";
  const extras = (input.customTypes ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(lang === "en" ? "; " : "；");

  const ctx: Ctx = {
    name,
    category,
    colorMaterial,
    otherInfo,
    ratio,
    resolution,
    hasDetail: !!input.hasDetailImage,
    hasStructure: !!input.hasStructureImage,
    extras,
    lang,
  };

  const base =
    typeof input.imageType === "string" && isImageTypeKey(input.imageType)
      ? lang === "en"
        ? wanEnForType(input.imageType, ctx)
        : wanZhForType(input.imageType, ctx)
      : lang === "en"
        ? wanCustomEn(input.imageType, ctx)
        : wanCustomZh(input.imageType, ctx);

  const extraClause = extras
    ? lang === "en"
      ? ` Additional requirements: ${extras}.`
      : `附加要求：${extras}。`
    : "";
  return `${base}${extraClause}`;
}

export function buildImagePrompt(input: BuildImagePromptInput): string {
  const lang: TargetLanguage = input.targetLanguage === "en" ? "en" : "zh";
  const name = (input.productName || "").trim() || (lang === "en" ? "the product" : "该产品");
  const category = categoryText(input.categoryL1, input.categoryL2);
  const colorMaterial =
    lang === "en"
      ? colorMaterialEn(input.color, input.material)
      : colorMaterialZh(input.color, input.material);
  const otherInfo = (input.productDescription || "").trim();
  const ratio = resolveRatio(
    input.aspectRatio,
    input.customAspectW,
    input.customAspectH,
  );
  const resolution = (input.resolution || "").trim() || "1024x1024";
  const extras = (input.customTypes ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(lang === "en" ? "; " : "；");

  const ctx: Ctx = {
    centerCrop: input.centerCrop !== false && !!centerCropSafeRatio(ratio, undefined, input.aspectRatio === "custom"),
    name,
    category,
    colorMaterial,
    otherInfo,
    ratio,
    resolution,
    hasDetail: !!input.hasDetailImage,
    hasStructure: !!input.hasStructureImage,
    extras,
    lang,
  };

  const base =
    typeof input.imageType === "string" && isImageTypeKey(input.imageType)
      ? lang === "en"
        ? buildBuiltInEn(input.imageType, ctx)
        : buildBuiltInZh(input.imageType, ctx)
      : lang === "en"
        ? buildCustomEn(input.imageType, ctx)
        : buildCustomZh(input.imageType, ctx);
  return `${headDirective(lang)}${base}${tailDirective(lang)}`;
}

// ── Image Creation prompt (PRD 图片创作工具) ────────────────────────────────
//
// Free-form prompt + optional ref-mode hints + product/brand snippets +
// aspect/resolution suffix, bracketed by language directives. Distinct from
// `buildImagePrompt` because the input shape is different (no per-image type
// templating — the user's prompt is the seed, not a built-in template).

export interface BuildImageCreationPromptInput {
  /** Free-form user prompt — the seed text. Required. */
  prompt: string;
  /** Number of attached reference images (paperclip uploads + generated-image
   *  refs + server-injected brand logo), in submission order AFTER the main
   *  images. The structured renderer emits one numbered reference-map line
   *  per attachment. Total ≤ 10 (UI guards). */
  attachedRefsCount?: number;
  /** Per-attachment provenance (image-creation only). Position-paired with
   *  the multipart `attachedRefs` files in submission order. When supplied,
   *  the reference map labels each line with its origin so the LLM can
   *  resolve chip tokens in the user prompt to specific reference images.
   *  Optional — absent / "paperclip" entries get the generic unannotated
   *  line. */
  attachedRefsSources?: AttachedRefSource[];
  /** Per-attachment chip number for `source === "generated"` entries.
   *  Carries the N from the editor's `[生成图N]` chip; used by the reference
   *  map to suffix the matching line with "labeled [生成图N]" so the LLM
   *  has an explicit text↔image binding. Position-paired with
   *  `attachedRefsSources`; null for non-generated entries. */
  attachedRefsChipNumbers?: (number | null)[];
  /** Pre-formatted chip-token strings (e.g. `"[生成图3-2]"`, `"[图5]"`).
   *  When a position has a non-null token, the reference-map line uses
   *  THIS string verbatim as the chip label, instead of reconstructing
   *  from chipNumber. Required so the LLM sees the new composite
   *  `[生成图T-N]` tokens that the user actually typed. Validated by the
   *  route handler to a strict regex before reaching this function.
   *  Position-paired with `attachedRefsSources` / `attachedRefsChipNumbers`. */
  attachedRefsChipTokens?: (string | null)[];
  /** Number of MAIN-rail reference images attached (PRD §2.1). Used to add
   *  a "main image fidelity" instruction prefix when > 0. */
  mainRefsCount?: number;
  /** Per-product-image role labels (产品/细节/包装/配件 or custom), position-
   *  paired with the main reference images. When present, each `[产品图N]`
   *  reference-map line is suffixed with its role so the model can tell, e.g.,
   *  an accessory shot from the main product. */
  mainRefsLabels?: string[];
  aspectRatio?: AspectRatio | string;
  customAspectW?: number;
  customAspectH?: number;
  /** How `customAspectW`/`customAspectH` are interpreted when
   *  `aspectRatio === "custom"`:
   *    - `"ratio"` (default) → ratio numerators (e.g. 16:9)
   *    - `"pixels"` → actual pixel dimensions (e.g. 1600x2000)
   *  The structured renderer uses this to keep ratio-vs-pixel semantics
   *  unambiguous in the prompt size suffix. */
  customSizeMode?: "ratio" | "pixels";
  resolution?: string;
  /** PRD §4.5 — "none" suppresses on-image text in any language. */
  targetLanguage?: TargetLanguage;
  /** 站点选择解析结果（`平台_国家码` 按国家动态推导的商城语言，见
   *  common/utils/marketplace-language）。设置后图上文字语言由站点商城
   *  语言硬性决定，优先于 targetLanguage 与"跟随提示词语言"规则；缺省时
   *  prompt 输出与现状逐字节一致。 */
  marketplaceLanguage?: MarketplaceLanguage;
  /** PRD §4.5 (revised) — how dense the on-image text should be. Layered
   *  on top of `targetLanguage` so callers can independently pick "what
   *  language" and "how much text". `density === "none"` overrides the
   *  language axis (no text at all). Defaults to "normal" when omitted. */
  textDensity?: TextDensity;
  /** Which image-creation page submitted this prompt. Selects the text-density
   *  directive shape: "ecommerce" (default) → structural marketing guidance,
   *  "general" → legacy word-count band. */
  imageCreationVariant?: ImageCreationVariant;
  /** Stage B/C will populate. Stage A safely ignores empty fields. */
  productInfo?: ProductInfoSnapshot;
  brandIdentity?: BrandIdentitySnapshot;
}

// ── v7 structured renderer types ───────────────────────────────────────────

export interface BuildImageCreationPromptOptions {
  renderLevel?: ImageCreationRenderLevel;
}

/** Discriminated union — the `legacy` arm intentionally lacks `renderLevel`
 *  (legacy renderer has no concept of it), the `structured` arm always has
 *  it. Type-narrowing on `version` lets call-sites read `renderLevel` only
 *  when it actually applies. */
export type ImageCreationPromptMeta =
  | {
      version: "legacy";
      truncated: boolean;
      originalBriefLength: number;
      finalPromptLength: number;
    }
  | {
      version: "structured";
      renderLevel: ImageCreationRenderLevel;
      truncated: boolean;
      originalBriefLength: number;
      finalPromptLength: number;
    };

export interface BuiltImageCreationPrompt {
  prompt: string;
  meta: ImageCreationPromptMeta;
}

function productInfoBlock(info: ProductInfoSnapshot, lang: "zh" | "en"): string {
  const bits: string[] = [];
  if (info.productName?.trim()) bits.push(info.productName.trim());
  const cat = categoryText(info.categoryL1 ?? "", info.categoryL2 ?? "");
  if (cat) bits.push(cat);
  const sps = (info.coreSellingPoints ?? []).filter((s) => s.trim().length > 0);
  if (sps.length > 0) {
    bits.push(
      lang === "en" ? `key selling points: ${sps.join(", ")}` : `核心卖点：${sps.join("、")}`,
    );
  }
  if (info.audiencePersona?.trim()) {
    bits.push(
      lang === "en"
        ? `target audience: ${info.audiencePersona.trim()}`
        : `目标受众：${info.audiencePersona.trim()}`,
    );
  }
  if (info.productDescription?.trim()) bits.push(info.productDescription.trim());
  if (bits.length === 0) return "";
  return lang === "en"
    ? `Product context — ${bits.join("; ")}.`
    : `产品信息：${bits.join("；")}。`;
}

function brandIdentityBlock(brand: BrandIdentitySnapshot, lang: "zh" | "en"): string {
  const bits: string[] = [];
  const colors = (brand.primaryColors ?? []).filter((c) => c.trim().length > 0);
  if (colors.length > 0) {
    bits.push(lang === "en" ? `brand colors ${colors.join(", ")}` : `品牌主色 ${colors.join("、")}`);
  }
  const styles = (brand.designStyles ?? []).filter((s) => s.trim().length > 0);
  if (styles.length > 0) {
    bits.push(
      lang === "en" ? `design style: ${styles.join(", ")}` : `设计风格：${styles.join("、")}`,
    );
  }
  if (brand.brandTone?.trim()) {
    bits.push(
      lang === "en" ? `brand tone: ${brand.brandTone.trim()}` : `品牌调性：${brand.brandTone.trim()}`,
    );
  }
  if (bits.length === 0) return "";
  return lang === "en"
    ? `Brand identity — ${bits.join("; ")}.`
    : `品牌基因：${bits.join("；")}。`;
}

export function buildImageCreationPrompt(input: BuildImageCreationPromptInput): string {
  const lang: TargetLanguage =
    input.targetLanguage === "en" || input.targetLanguage === "none"
      ? input.targetLanguage
      : "zh";
  const density: TextDensity = input.textDensity ?? "normal";
  const variant: ImageCreationVariant = input.imageCreationVariant ?? "ecommerce";
  const marketplace = input.marketplaceLanguage;
  // Effective lang for prose blocks: "none" still uses Chinese prose to
  // describe the scene; only the on-image-text directive flips to "no text".
  const proseLang: "zh" | "en" = lang === "en" ? "en" : "zh";

  const ratio = resolveRatio(input.aspectRatio, input.customAspectW, input.customAspectH);
  const resolution = (input.resolution || "").trim() || "1024x1024";

  const userPrompt = (input.prompt || "").trim();
  const mainRefs = input.mainRefsCount ?? 0;
  const attachedRefs = input.attachedRefsCount ?? 0;
  const refBlock =
    attachedRefs > 0
      ? proseLang === "en"
        ? `${attachedRefs} user-attached reference image${attachedRefs > 1 ? "s" : ""} provided — combine their visual elements with the brief.`
        : `已提供 ${attachedRefs} 张用户附加的参考图，请综合借鉴其视觉元素。`
      : "";
  const productBlock = input.productInfo
    ? productInfoBlock(input.productInfo, proseLang)
    : "";
  const brandBlock = input.brandIdentity
    ? brandIdentityBlock(input.brandIdentity, proseLang)
    : "";

  // Per-image role breakdown (产品/细节/包装/配件/自定义) — only emitted when at
  // least one image carries a non-default role, so the model can distinguish
  // e.g. an accessory shot from the main product.
  const roleList = (input.mainRefsLabels ?? []).slice(0, mainRefs);
  const hasRoles = roleList.some((r) => {
    const t = (r ?? "").trim();
    return t.length > 0 && t !== "产品";
  });
  const roleBreakdown = !hasRoles
    ? ""
    : proseLang === "en"
      ? ` (${roleList
          .map((r, i) => `image ${i + 1}: ${(r ?? "").trim() || "product"}`)
          .join("; ")})`
      : `（${roleList
          .map((r, i) => `图${i + 1}：${(r ?? "").trim() || "产品"}`)
          .join("；")}）`;
  const mainRefHint =
    mainRefs > 0
      ? proseLang === "en"
        ? `Product references (${mainRefs})${roleBreakdown} — keep the product identity, color and material strictly consistent with these.`
        : `已提供 ${mainRefs} 张产品图${roleBreakdown}，作为产品本体的强约束参考，请严格保持产品外观、颜色、材质与产品图一致。`
      : "";

  const sizeSuffix =
    proseLang === "en"
      ? `Aspect ratio ${ratio}, ${resolution} resolution.`
      : `${ratio} 比例，${resolution} 分辨率。`;

  const fallbackSeed =
    proseLang === "en"
      ? "Generate a high-quality commercial image based on the provided references."
      : "请基于提供的参考图生成一张高品质的商品/营销图。";

  const body = [mainRefHint, refBlock, productBlock, brandBlock, userPrompt || fallbackSeed, sizeSuffix]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(" ");

  return `${headDirectiveImageCreation(lang, density, variant, marketplace)}${body}${tailDirectiveImageCreation(lang, density, variant, marketplace)}`;
}

// ── v7 Structured renderer (image-creation only) ───────────────────────────
//
// New entry point for the image-creation prompt compiler v7. Lives alongside
// the legacy `buildImageCreationPrompt` (which stays untouched so existing
// snapshot tests and legacy callers can roll back at any time).
//
// Differences from legacy:
//   1. Reference map (改动 A): numbered "Image 1-2 main / Image 3 attached /
//      ..." keyed off `mainRefsCount` + `attachedRefsCount` instead of
//      grouped counts.
//   2. Priority block (改动 B): explicit conflict-resolution order, only in
//      `full` renderLevel.
//   3. Full ProductInfo / BrandIdentity coverage (改动 C): all 19 + 7 fields,
//      with truncation/limit rules, only in `full`.
//   4. Strengthened text-free directive (改动 D): canonical TEXT_FREE_BAN_TERMS
//      list — head AND tail both enumerate the same forbidden glyph forms.
//      Used INSIDE this renderer only; the shared `headDirective`/
//      `tailDirective` legacy callers see is unchanged.
//   5. Brief truncation (改动 E): user prompt is sliced to 500 chars with
//      a `[brief truncated]` / `[简介已截断]` marker, surfaced in metadata.
//
// `renderLevel` controls which sections are emitted (see assembleStructured).

const TEXT_FREE_BAN_TERMS = [
  "text",
  "captions",
  "labels",
  "annotations",
  "callouts",
  "dimension numbers",
  "brand wordmarks",
  "stickers",
  "logos containing letters",
  "glyphs",
  "brand names",
] as const;

const TEXT_FREE_BAN_TERMS_ZH = [
  "文字",
  "标题",
  "标签",
  "标注",
  "卖点说明",
  "尺寸数字",
  "品牌字标",
  "贴纸",
  "含字母的 LOGO",
  "字形",
  "品牌名",
] as const;

const STRUCTURED_BRIEF_LIMIT = 500;
const LONG_TEXT_LIMIT = 200;
const MAX_SELLING_POINTS = 5;
const MAX_CERTIFICATIONS = 5;
const MAX_PRIMARY_COLORS = 5;
const MAX_DESIGN_STYLES = 6;
const MAX_PATTERN_ELEMENTS = 6;

function structuredHeadDirective(
  lang: TargetLanguage,
  density: TextDensity,
  variant: ImageCreationVariant = "ecommerce",
  marketplace?: MarketplaceLanguage,
): string {
  // No-text branch — emit the strengthened canonical ban list. Both English
  // and Chinese head copy enumerates the same forbidden categories so the
  // model can't sneak any of them through one of the two directives.
  if (lang === "none" || density === "none") {
    if (lang === "zh") {
      return `硬性要求：图片必须完全不包含任何文字。不得渲染${TEXT_FREE_BAN_TERMS_ZH.join("、")}，无论使用任何语言或字符。`;
    }
    return `TEXT-FREE OUTPUT REQUIRED. Do not render ${TEXT_FREE_BAN_TERMS.join(", ")} in any script.`;
  }
  // For language-bound paths, use the image-creation soft directive — the EN/中文
  // selector was removed (2026-05-20) and the on-image text language now
  // follows the user's brief, defaulting to English when unspecified — unless
  // a marketplace site language was resolved, which then takes precedence.
  return headDirectiveImageCreation(lang, density, variant, marketplace);
}

function structuredTailDirective(
  lang: TargetLanguage,
  density: TextDensity,
  variant: ImageCreationVariant = "ecommerce",
  marketplace?: MarketplaceLanguage,
): string {
  if (lang === "none" || density === "none") {
    if (lang === "zh") {
      return `最后提醒：图片必须完全不含任何文字。即使品牌资料中给出了名称，也禁止渲染${TEXT_FREE_BAN_TERMS_ZH.join("、")}。`;
    }
    return ` Final reminder: the image must be entirely text-free. Do NOT render ${TEXT_FREE_BAN_TERMS.join(", ")}, even if those names are provided in the brand identity.`;
  }
  return tailDirectiveImageCreation(lang, density, variant, marketplace);
}

/** Build a numbered reference map ("Image 1-2: main..., Image 3: attached
 *  reference..."). Returns "" when there are no references at all.
 *
 *  When `attachedRefsSources` / `attachedRefsChipNumbers` are supplied (the
 *  image-creation tool always supplies them), each line is suffixed with the
 *  exact chip token the user can write in the prompt — `[产品图N]` for
 *  product images and `(labeled [生成图N])` for generated-image references.
 *  This is the *explicit* text↔image binding that lets the LLM resolve
 *  "基于 [生成图3] 风格" to a specific image in the reference array;
 *  without it the LLM has to guess which "Image M: scene reference" the
 *  user meant. */
function referenceMapBlock(
  mainRefsCount: number,
  attachedRefsCount: number,
  lang: "zh" | "en",
  attachedRefsSources?: AttachedRefSource[],
  attachedRefsChipNumbers?: (number | null)[],
  attachedRefsChipTokens?: (string | null)[],
  mainRefsLabels?: string[],
): string {
  const lines: string[] = [];
  let cursor = 0;

  // Product references — emit one labeled line per image so each
  // `[产品图N]` chip in the user's prompt has a 1:1 anchor (instead of
  // folding 1..N into a single range line that leaves the LLM to count
  // slots itself).
  if (mainRefsCount > 0) {
    for (let i = 1; i <= mainRefsCount; i++) {
      cursor += 1;
      const slot = cursor;
      const isLastMain = i === mainRefsCount;
      // Per-image role label (产品/细节/包装/配件/自定义) so the model can tell
      // an accessory / packaging / detail shot from the main product. Default
      // 产品 carries no extra hint (it's already "product reference").
      const role = (mainRefsLabels?.[i - 1] ?? "").trim();
      const hasRole = role.length > 0 && role !== "产品";
      const roleEn = hasRole ? `, role: ${role}` : "";
      const roleZh = hasRole ? `，用途：${role}` : "";
      // First product image carries the body of the directive; subsequent
      // ones just reference the same rules to keep the prompt from ballooning.
      if (lang === "en") {
        if (i === 1) {
          lines.push(
            `Image ${slot} (labeled [产品图${i}]${roleEn}): product reference. Preserve product identity, shape, color, material, proportions, visible details, and key components.${mainRefsCount > 1 ? " Subsequent product references reinforce the same product identity." : ""}`,
          );
        } else {
          lines.push(
            `Image ${slot} (labeled [产品图${i}]${roleEn}): product reference — same identity rules apply.${isLastMain ? "" : ""}`,
          );
        }
      } else {
        if (i === 1) {
          lines.push(
            `图 ${slot}（即 [产品图${i}]${roleZh}）：产品参考图。保持产品外观、形状、颜色、材质、比例、可见细节和关键部件一致。${mainRefsCount > 1 ? "后续产品图均沿用同一产品身份。" : ""}`,
          );
        } else {
          lines.push(
            `图 ${slot}（即 [产品图${i}]${roleZh}）：产品参考图，沿用上述产品身份约束。${isLastMain ? "" : ""}`,
          );
        }
      }
    }
  }

  // Attached references — one numbered line per file, respecting submission
  // order so the model maps "Image N" to the same array slot the provider
  // sends. Sources/chipNumbers (when supplied) attach the exact chip token
  // the user inserted in the prompt as an explicit anchor.
  //
  // All attached refs are uniform "reference images" (labeled `[图N]` when
  // they carry a chip identity); the LLM combines them with the prompt
  // holistically. Refs without a chip token fall back to a generic
  // unlabeled reference line.
  const sources = attachedRefsSources ?? [];
  const chipNs = attachedRefsChipNumbers ?? [];
  const chipTokens = attachedRefsChipTokens ?? [];
  for (let attachedIdx = 0; attachedIdx < attachedRefsCount; attachedIdx++) {
    cursor += 1;
    const idx = cursor;
    const source = sources[attachedIdx] ?? "paperclip";
    const chipN = chipNs[attachedIdx];
    const chipToken = chipTokens[attachedIdx];

    // Brand LOGO (server-injected from 品牌基因 logoUrl). Give it a DEDICATED
    // line that names which image is the logo and binds the user's "品牌LOGO"
    // wording to it — otherwise, among several refs, the model can't tell
    // which one is the brand mark (and invents one).
    if (source === "brand-logo") {
      if (lang === "en") {
        lines.push(
          `Image ${idx}: the brand LOGO — when the brief mentions "brand logo" / "logo", it refers to THIS image. Use it as the brand mark: place it exactly where the brief directs (default a top corner), reproduce its graphics, lettering, and proportions verbatim, and do NOT redraw, recolor, distort, or substitute it. It is NOT the product and NOT a scene/style reference.`,
        );
      } else {
        lines.push(
          `图 ${idx}：品牌 LOGO 图 —— 用户提示词中提到"品牌 LOGO / LOGO"即指本图。作为品牌标识使用：严格按创意描述的位置放置（未指定则置于顶部一角），原样复刻其图形、文字与比例，不要重画、改色、变形或替换。它不是产品本体，也不是场景/风格参考。`,
        );
      }
      continue;
    }

    // Generated-image refs keep their dedicated [生成图...] anchor. Prefer
    // the pre-formatted token from the client (carries the new composite
    // `[生成图T-N]` form); fall back to legacy `[生成图${chipN}]` if the
    // client didn't ship a token (old payload).
    if (source === "generated") {
      const token =
        typeof chipToken === "string" && chipToken.length > 0
          ? chipToken
          : typeof chipN === "number"
            ? `[生成图${chipN}]`
            : null;
      if (token) {
        if (lang === "en") {
          lines.push(
            `Image ${idx} (labeled ${token} — when the user prompt mentions "${token}" it refers to this specific image): a previously generated frame, brought in as a reference. Use it as an anchor for whatever the user describes in the brief.`,
          );
        } else {
          lines.push(
            `图 ${idx}（即 ${token} —— 用户提示词中出现 "${token}" 即指本图）：之前生成的图作为参考。按用户在描述中提到的方式使用。`,
          );
        }
        continue;
      }
    }

    // Paperclip refs with a chip identity — emit the unified [图N] label.
    if (source === "paperclip" || source === undefined) {
      const token =
        typeof chipToken === "string" && chipToken.length > 0
          ? chipToken
          : typeof chipN === "number"
            ? `[图${chipN}]`
            : null;
      if (token) {
        if (lang === "en") {
          lines.push(
            `Image ${idx} (labeled ${token} — when the user prompt mentions "${token}" it refers to this specific image): a user-attached reference image. Combine its visual elements (composition, palette, scene, mood, subject) with the brief; do not copy the product identity from it (that comes from [产品图N]).`,
          );
        } else {
          lines.push(
            `图 ${idx}（即 ${token} —— 用户提示词中出现 "${token}" 即指本图）：用户附加的参考图。综合借鉴其视觉元素（构图、配色、场景、氛围、主体），但不要照搬产品本体（产品本体以 [产品图N] 为准）。`,
          );
        }
        continue;
      }
    }

    // Back-compat path — legacy refs that have a source but no chipNumber
    // (or a "main" source). Falls back to a generic reference description
    // so old saved sessions keep producing valid prompts.
    const legacyTrailEn =
      source === "main" ? ` (a previously-uploaded product image re-fed as a reference)` : "";
    const legacyTrailZh =
      source === "main" ? `（来自产品图栏，作为额外参考重新引入）` : "";
    if (lang === "en") {
      lines.push(
        `Image ${idx}: a user-attached reference image. Combine its visual elements (composition, palette, scene, mood, subject) with the brief; do not copy the product identity from it.${legacyTrailEn}`,
      );
    } else {
      lines.push(
        `图 ${idx}：用户附加的参考图。综合借鉴其视觉元素（构图、配色、场景、氛围、主体），但不要照搬产品本体。${legacyTrailZh}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * 默认前置硬规则：保持产品一致性。
 *
 * 与 `mainHint`（陈述"已提供 N 张产品图"）不同，本段是**禁令式**的硬约束，
 * 强调"输出图中的产品本体必须与产品图完全一致"。`full` / `compact` 都输出；
 * `minimal` 不输出（minimal 是兜底，不强加规则）。无产品图时返回空字符串
 * （没有对照基准，硬规则没意义）。
 */
function productConsistencyDirective(
  hasMainRef: boolean,
  lang: "zh" | "en",
): string {
  if (!hasMainRef) return "";
  return lang === "en"
    ? "PRODUCT CONSISTENCY (mandatory): the product depicted in the output image MUST visually match the product reference(s) — same shape, proportions, color, material, finish, and key components. Do not redesign, restyle, or substitute the product with similar items."
    : "产品一致性（硬性要求）：输出图中的产品本体必须与产品图参考视觉上完全一致 —— 形状、比例、颜色、材质、表面工艺、关键部件不得改动。不得重设计、不得换风格、不得替换为相似品。";
}

/**
 * @param brandColorAsDefault when true, append a rule clarifying that
 *   user/template-specified colors win and the brand primary colors are only a
 *   default (MAGA §4.1 — fixes brand color overriding a color-bearing template).
 * @param bridgeBriefToFacts when true, append a rule telling the model that
 *   when the brief names a product/brand field (核心卖点 / 主色 / 规格 / …) it
 *   must use the value listed in the Product facts / Brand identity blocks —
 *   bridging the otherwise-implicit terminology match between the free-text
 *   brief and the labeled fact blocks. Passed only by the structured renderer,
 *   and only when those fact blocks are actually present.
 *
 * Both flags default false so the legacy renderer's output stays byte-identical.
 * The base 5 rules are numbered dynamically so appended rules slot in cleanly.
 */
function priorityBlock(
  lang: "zh" | "en",
  brandColorAsDefault = false,
  bridgeBriefToFacts = false,
): string {
  if (lang === "en") {
    const rules = [
      "Preserve the product identity from the product references.",
      "Follow the on-image text and language rules.",
      "Use only provided product and brand facts; do not invent missing facts.",
      "Use auxiliary references only for their assigned roles.",
      "Follow the user creative brief where it does not conflict with the above.",
    ];
    if (brandColorAsDefault) {
      rules.push(
        "If the user brief or the selected template/scheme specifies colors, those colors take precedence; the brand primary colors apply only as a default when no colors are specified.",
      );
    }
    if (bridgeBriefToFacts) {
      rules.push(
        "When the brief refers to a product or brand field (e.g. selling points, primary color, spec, brand tone), use the corresponding value listed in the Product facts / Brand identity above — do not invent or substitute it.",
      );
    }
    return [
      "If any instructions conflict, follow this priority order:",
      ...rules.map((r, i) => `(${i + 1}) ${r}`),
    ].join("\n");
  }
  const rules = [
    "优先保持产品图中的产品身份一致。",
    "优先遵守图中文字和语言规则。",
    "仅使用已提供的产品事实和品牌事实，不编造缺失信息。",
    "附加参考图只在其指定角色内生效。",
    "用户创意描述只在不冲突时生效。",
  ];
  if (brandColorAsDefault) {
    rules.push(
      "若用户创意或所选模板/套图方案明确指定了配色，以指定配色为准；品牌主色仅在未指定配色时作为默认。",
    );
  }
  if (bridgeBriefToFacts) {
    rules.push(
      "当创意中提到产品资料或品牌基因里的字段（如核心卖点、主色、规格、品牌调性等），一律以上方「产品资料」「品牌基因」中列出的对应值为准，不要自行编造或替换。",
    );
  }
  return [
    "如果指令之间发生冲突，按以下优先级执行：",
    ...rules.map((r, i) => `（${i + 1}）${r}`),
  ].join("\n");
}

function truncateLong(text: string | undefined, max: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function takeNonEmpty(items: readonly string[] | undefined, max: number): string[] {
  if (!items) return [];
  const cleaned: string[] = [];
  for (const it of items) {
    const t = it.trim();
    if (t) cleaned.push(t);
    if (cleaned.length >= max) break;
  }
  return cleaned;
}

function structuredProductBlock(
  info: ProductInfoSnapshot,
  lang: "zh" | "en",
): string {
  const facts: string[] = [];
  const en = lang === "en";

  const push = (zhLabel: string, enLabel: string, value: string | null) => {
    if (!value) return;
    facts.push(en ? `${enLabel}: ${value}` : `${zhLabel}：${value}`);
  };
  const pushList = (zhLabel: string, enLabel: string, values: string[]) => {
    if (values.length === 0) return;
    facts.push(
      en ? `${enLabel}: ${values.join(", ")}` : `${zhLabel}：${values.join("、")}`,
    );
  };

  const productName = info.productName?.trim();
  if (productName) push("产品名称", "Product name", productName);

  // targetCountry + ecommercePlatform → single sentence, see plan §改动 C.
  // Both fields are `string[]` post-2026-05 (was `string`); join into a
  // human-readable list for the prompt while still surfacing multi-value
  // selections to the LLM.
  const country = Array.isArray(info.targetCountry)
    ? info.targetCountry.filter((c) => c?.trim()).join(" / ")
    : "";
  const platform = Array.isArray(info.ecommercePlatform)
    ? info.ecommercePlatform.filter((p) => p?.trim()).join(" / ")
    : "";
  if (country && platform) {
    facts.push(
      en
        ? `Designed for ${country} ${platform} listings.`
        : `针对 ${country} ${platform} 渠道设计。`,
    );
  } else if (country) {
    push("目标国家", "Target market", country);
  } else if (platform) {
    push("渠道", "E-commerce platform", platform);
  }

  const cat = categoryText(info.categoryL1 ?? "", info.categoryL2 ?? "");
  if (cat) push("类目", "Category", cat);

  pushList(
    "核心卖点",
    "Key selling points",
    takeNonEmpty(info.coreSellingPoints, MAX_SELLING_POINTS),
  );
  pushList(
    "认证",
    "Certifications",
    takeNonEmpty(info.certifications, MAX_CERTIFICATIONS),
  );

  push("目标受众", "Target audience", info.audiencePersona?.trim() || null);
  push("年龄段", "Age group", info.ageGroup?.trim() || null);
  push("消费档位", "Consumer tier", info.consumerTier?.trim() || null);

  push(
    "产品描述",
    "Product description",
    truncateLong(info.productDescription, LONG_TEXT_LIMIT),
  );

  // Unified 商品属性 emission (post-2026-05). New product-resource drawer
  // captures product specifics as `attributes: {key, value}[]`. Legacy
  // records may still have flat fields (spec / size / ingredients / ...)
  // populated — those are auto-converted to KV pairs here so they keep
  // contributing to the prompt without a UI surface. When the same key
  // appears in both, the new `attributes` entry wins (user explicitly
  // edited the KV table).
  const attrPairs = collectProductAttributes(info);
  if (attrPairs.length > 0) {
    push(
      "商品属性",
      "Product attributes",
      attrPairs.map(([k, v]) => `${k}: ${v}`).join(en ? "; " : "；"),
    );
  }

  if (facts.length === 0) return "";
  return en
    ? `Product facts — ${facts.join("; ")}.`
    : `产品资料：${facts.join("；")}。`;
}

/** Build the deduped K/V attribute list from BOTH legacy flat fields and
 *  the new `attributes` array. Legacy fields are appended first under
 *  canonical Chinese keys; the new `attributes` entries are appended last
 *  so they override on key collision. Values are length-clamped to
 *  `LONG_TEXT_LIMIT` to keep the prompt tractable. */
function collectProductAttributes(
  info: ProductInfoSnapshot,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const legacyMap: Array<[string, string | undefined]> = [
    ["规格", info.spec],
    ["尺寸", info.size],
    ["成分", info.ingredients],
    ["使用说明", info.usageInstructions],
    ["保质期", info.shelfLife],
    ["质感", info.textureFinish],
    ["结构", info.structureFeature],
    ["包装", info.packagingFeature],
  ];
  for (const [k, raw] of legacyMap) {
    const v = truncateLong(raw, LONG_TEXT_LIMIT);
    if (v) pairs.push([k, v]);
  }
  if (Array.isArray(info.attributes)) {
    for (const a of info.attributes) {
      const key = a?.key?.trim();
      const value = truncateLong(a?.value, LONG_TEXT_LIMIT);
      if (key && value) pairs.push([key, value]);
    }
  }
  // last-write-wins dedupe — preserves order of first occurrence but uses
  // the later value (so explicit `attributes` overrides legacy fallback).
  const valueByKey = new Map<string, string>();
  const orderByKey = new Map<string, number>();
  pairs.forEach(([k, v], i) => {
    if (!orderByKey.has(k)) orderByKey.set(k, i);
    valueByKey.set(k, v);
  });
  return Array.from(valueByKey.entries()).sort(
    (a, b) => (orderByKey.get(a[0]) ?? 0) - (orderByKey.get(b[0]) ?? 0),
  );
}

function structuredBrandBlock(
  brand: BrandIdentitySnapshot,
  lang: "zh" | "en",
  density: TextDensity,
): string {
  const facts: string[] = [];
  const en = lang === "en";
  const skipNamesAndFont = density === "none";

  const push = (zhLabel: string, enLabel: string, value: string | null) => {
    if (!value) return;
    facts.push(en ? `${enLabel}: ${value}` : `${zhLabel}：${value}`);
  };
  const pushList = (zhLabel: string, enLabel: string, values: string[]) => {
    if (values.length === 0) return;
    facts.push(
      en ? `${enLabel}: ${values.join(", ")}` : `${zhLabel}：${values.join("、")}`,
    );
  };

  if (!skipNamesAndFont) {
    push("中文品牌名", "Brand name (zh)", brand.brandNameZh?.trim() || null);
    push("English brand name", "Brand name (en)", brand.brandNameEn?.trim() || null);
  }

  // 主色 carries MAGA's "default palette" framing AND the `applyBrandColor`
  // gate: when the brand-level toggle is explicitly off, the primary-color
  // line is dropped entirely (names / styles / tone still emit). The softened
  // wording tells the model the palette is only a default — a brief or
  // template that specifies colors wins (reinforced by priorityBlock's rule 6).
  const brandColors =
    brand.applyBrandColor === false
      ? []
      : takeNonEmpty(brand.primaryColors, MAX_PRIMARY_COLORS);
  if (brandColors.length > 0) {
    facts.push(
      en
        ? `Brand colors (default palette — if the brief or selected template specifies colors, follow those): ${brandColors.join(", ")}`
        : `主色（默认配色，若创意/所选模板另有指定则以指定为准）：${brandColors.join("、")}`,
    );
  }
  pushList(
    "设计风格",
    "Design styles",
    takeNonEmpty(brand.designStyles, MAX_DESIGN_STYLES),
  );
  pushList(
    "图形元素",
    "Pattern elements",
    takeNonEmpty(brand.patternElements, MAX_PATTERN_ELEMENTS),
  );

  if (!skipNamesAndFont) {
    push("字体风格", "Font style", brand.fontStyle?.trim() || null);
  }
  push("品牌调性", "Brand tone", brand.brandTone?.trim() || null);

  // logoUrl is intentionally never inlined into the prompt — it goes through
  // attachedRefs as a `logo`-mode image instead.

  if (facts.length === 0) return "";
  const block = en
    ? `Brand identity — ${facts.join("; ")}.`
    : `品牌基因：${facts.join("；")}。`;

  // 主色 position + coverage directive (MAGA §3.3). A bare "主色：#A、#B" list is
  // read as accent-only — the model barely tints backgrounds and, when there's
  // on-image text, spends the palette on the text instead. Promote the palette
  // to a dominant background/large-area role with primary↔accent roles, and
  // make background coloring outrank text coloring. Only when colors were
  // actually emitted (so it stays gated by `applyBrandColor` + non-empty).
  if (brandColors.length === 0) return block;
  const coverage = en
    ? " Apply the brand colors to large areas — backgrounds, large color blocks, and decorative shapes — so the brand palette visibly dominates the frame (color the background first); use the remaining colors as accents. Text MAY use the brand colors but must not claim them first: coloring large backgrounds/blocks outranks coloring text, and text prioritizes legibility. The product's own colors stay true to life."
    : "主色用于背景、大色块与装饰图形等大面积区域，品牌色系应在画面中占主导（背景优先着色），其余作辅助点缀色；文字可使用品牌色但不优先占用——大面积背景/色块着色优先于文字着色，文字以可读性为准；产品本体颜色保持真实不变。";
  return block + coverage;
}

function structuredSizeSuffix(
  ratio: string,
  resolution: string,
  customSizeMode: "ratio" | "pixels" | undefined,
  isCustomAspect: boolean,
  lang: "zh" | "en",
): string {
  // When the caller is using `customSizeMode === "pixels"`, `ratio` is the
  // raw "WxH" pixel literal, not a ratio. Phrase the suffix accordingly so
  // the model isn't told to treat e.g. 1600:2000 as a ratio.
  if (isCustomAspect && customSizeMode === "pixels") {
    return lang === "en"
      ? `Output dimensions: ${ratio} pixels (${resolution}).`
      : `输出像素尺寸：${ratio}（${resolution}）。`;
  }
  return lang === "en"
    ? `Aspect ratio ${ratio}, ${resolution} resolution.`
    : `${ratio} 比例，${resolution} 分辨率。`;
}

interface StructuredSections {
  head: string;
  mainHint: string;
  consistency: string;
  refMap: string;
  productBlock: string;
  brandBlock: string;
  brief: string;
  sizeSuffix: string;
  priority: string;
  tail: string;
}

function assembleStructured(
  level: ImageCreationRenderLevel,
  s: StructuredSections,
): string {
  const order: (keyof StructuredSections)[] =
    level === "minimal"
      ? ["head", "brief", "tail"]
      : level === "compact"
        ? ["head", "mainHint", "consistency", "refMap", "brief", "sizeSuffix", "tail"]
        : [
            "head",
            "mainHint",
            "consistency",
            "refMap",
            "productBlock",
            "brandBlock",
            "brief",
            "sizeSuffix",
            "priority",
            "tail",
          ];
  return order
    .map((k) => s[k])
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .join("\n\n");
}

export function buildImageCreationPromptStructured(
  input: BuildImageCreationPromptInput,
  options: BuildImageCreationPromptOptions = {},
): BuiltImageCreationPrompt {
  const renderLevel: ImageCreationRenderLevel = options.renderLevel ?? "full";

  const lang: TargetLanguage =
    input.targetLanguage === "en" || input.targetLanguage === "none"
      ? input.targetLanguage
      : "zh";
  const density: TextDensity = input.textDensity ?? "normal";
  const variant: ImageCreationVariant = input.imageCreationVariant ?? "ecommerce";
  const marketplace = input.marketplaceLanguage;
  const proseLang: "zh" | "en" = lang === "en" ? "en" : "zh";

  const ratio = resolveRatio(input.aspectRatio, input.customAspectW, input.customAspectH);
  const resolution = (input.resolution || "").trim() || "1024x1024";
  const isCustomAspect = (input.aspectRatio?.toString().trim() ?? "") === "custom";

  // Brief truncation (改动 E) + legacy chip token migration.
  //
  // Pre-2026-05 sessions saved chip tokens as `[主图N]`; the editor now
  // emits `[产品图N]` and the reference map only labels images as
  // `[产品图N]`. Migrate any legacy tokens that survive in saved prompts
  // so the LLM always sees a consistent label-↔-reference binding.
  const rawBriefRaw = input.prompt ?? "";
  const rawBrief = rawBriefRaw.replace(/\[主图(\d+)\]/g, "[产品图$1]");
  const originalBriefLength = rawBrief.length;
  let truncated = false;
  let userPrompt = rawBrief.trim();
  if (rawBrief.length > STRUCTURED_BRIEF_LIMIT) {
    const sliced = rawBrief.slice(0, STRUCTURED_BRIEF_LIMIT).trim();
    const marker = proseLang === "en" ? " [brief truncated]" : "[简介已截断]";
    userPrompt = `${sliced}${marker}`;
    truncated = true;
  }

  const fallbackSeed =
    proseLang === "en"
      ? "Generate a high-quality commercial image based on the provided references."
      : "请基于提供的参考图生成一张高品质的商品/营销图。";
  const brief = userPrompt || fallbackSeed;

  const mainRefs = input.mainRefsCount ?? 0;
  const mainHint =
    mainRefs > 0
      ? proseLang === "en"
        ? `Product references (${mainRefs}) — keep the product identity, color and material strictly consistent with these.`
        : `已提供 ${mainRefs} 张产品图，作为产品本体的强约束参考，请严格保持产品外观、颜色、材质与产品图一致。`
      : "";

  const refMap = referenceMapBlock(
    mainRefs,
    input.attachedRefsCount ?? input.attachedRefsSources?.length ?? 0,
    proseLang,
    input.attachedRefsSources,
    input.attachedRefsChipNumbers,
    input.attachedRefsChipTokens,
    input.mainRefsLabels,
  );

  const productBlock = input.productInfo
    ? structuredProductBlock(input.productInfo, proseLang)
    : "";
  const brandBlock = input.brandIdentity
    ? structuredBrandBlock(input.brandIdentity, proseLang, density)
    : "";
  // Whether the brand block actually emitted a 主色 line (toggle on + colors
  // present). Drives priorityBlock rule (6) so the "colors are only a default"
  // clause appears only when there's a brand palette to qualify.
  const brandColorsActive =
    !!input.brandIdentity &&
    input.brandIdentity.applyBrandColor !== false &&
    takeNonEmpty(input.brandIdentity.primaryColors, MAX_PRIMARY_COLORS).length >
      0;

  const sizeSuffix = structuredSizeSuffix(
    ratio,
    resolution,
    input.customSizeMode,
    isCustomAspect,
    proseLang,
  );

  const sections: StructuredSections = {
    head: structuredHeadDirective(lang, density, variant, marketplace),
    mainHint,
    consistency: productConsistencyDirective(mainRefs > 0, proseLang),
    refMap,
    productBlock,
    brandBlock,
    brief,
    sizeSuffix,
    priority: priorityBlock(
      proseLang,
      brandColorsActive,
      // Bridge brief→facts only when there are actually labeled facts to bind
      // the brief's field references to.
      productBlock !== "" || brandBlock !== "",
    ),
    tail: structuredTailDirective(lang, density, variant, marketplace),
  };

  const prompt = assembleStructured(renderLevel, sections);

  return {
    prompt,
    meta: {
      version: "structured",
      renderLevel,
      truncated,
      originalBriefLength,
      finalPromptLength: prompt.length,
    },
  };
}
