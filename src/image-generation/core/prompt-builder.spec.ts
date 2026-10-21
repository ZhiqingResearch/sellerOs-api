// src/server/image/prompt-builder.test.ts
import { buildImageCreationPrompt, buildImagePrompt } from "./prompt-builder";
import { IMAGE_TYPE_LABELS, type ImageTypeKey } from "./types";

const BASE = {
  productName: "三件装透气速干短袖 T 恤",
  categoryL1: "服装鞋帽",
  categoryL2: "男士速干 T 恤",
  productDescription: "采用透气速干面料，吸湿排汗效果佳。三件装包含黑白灰经典配色，适合运动健身或日常穿着。",
  aspectRatio: "1:1" as const,
  resolution: "1024x1024",
};

describe("buildImagePrompt — preset templates", () => {
  it.each(["zh", "en"] as const)("%s 特殊比例主图/俯视图移除 85%%，常用比例保持不变", lang => {
    for (const imageType of ["main_white_front", "top_down"] as const) {
      const input = { ...BASE, imageType, targetLanguage: lang };
      expect(buildImagePrompt(input)).toContain("85%");
      expect(buildImagePrompt({ ...input, aspectRatio: "4:5" })).not.toContain("85%");
      expect(buildImagePrompt({ ...input, aspectRatio: "custom", customAspectW: 16, customAspectH: 9 })).not.toContain("85%");
      expect(buildImagePrompt({ ...input, aspectRatio: "4:5", centerCrop: false })).toContain("85%");
    }
  });

  it("produces a stable Chinese prompt for each of the 10 built-in image types", () => {
    const keys = Object.keys(IMAGE_TYPE_LABELS) as ImageTypeKey[];
    const snapshot: Record<string, string> = {};
    for (const key of keys) {
      snapshot[key] = buildImagePrompt({ ...BASE, imageType: key });
    }
    expect(snapshot).toMatchSnapshot();
  });

  it("embeds 30 / 45 / 90 angle into the side-view template", () => {
    const p30 = buildImagePrompt({ ...BASE, imageType: "side_30" });
    const p45 = buildImagePrompt({ ...BASE, imageType: "side_45" });
    const p90 = buildImagePrompt({ ...BASE, imageType: "side_90" });
    expect(p30).toContain("产品 30 度侧面角度");
    expect(p45).toContain("产品 45 度侧面角度");
    expect(p90).toContain("产品 90 度侧面角度");
  });

  it("switches the side-view reference clause based on hasStructureImage", () => {
    const withStruct = buildImagePrompt({
      ...BASE,
      imageType: "side_45",
      hasStructureImage: true,
    });
    const withoutStruct = buildImagePrompt({
      ...BASE,
      imageType: "side_45",
      hasStructureImage: false,
    });
    expect(withStruct).toContain("参考提供的“结构/背面图”还原真实侧面细节");
    expect(withoutStruct).toContain("基于图 1 合理推断");
  });

  it("uses detail-image reference for detail_closeup only when hasDetailImage", () => {
    const on = buildImagePrompt({
      ...BASE,
      imageType: "detail_closeup",
      hasDetailImage: true,
    });
    const off = buildImagePrompt({
      ...BASE,
      imageType: "detail_closeup",
      hasDetailImage: false,
    });
    expect(on).toContain("必须 100% 还原提供的“细节纹理图”中的纹理 / 接口 / 按钮真实细节");
    expect(off).toContain("基于图 1 主体合理放大推断细节");
  });

  it("uses size-image reference for size_annotation only when hasStructureImage", () => {
    const on = buildImagePrompt({
      ...BASE,
      imageType: "size_annotation",
      hasStructureImage: true,
    });
    const off = buildImagePrompt({
      ...BASE,
      imageType: "size_annotation",
      hasStructureImage: false,
    });
    expect(on).toContain("标注的尺寸数据必须来自提供的“尺码参考图”");
    expect(off).toContain("使用常见行业尺寸估计");
  });

  it("omits the color/material clause when neither is provided", () => {
    const p = buildImagePrompt({
      productName: "Wireless Headphones",
      categoryL1: "Electronics",
      categoryL2: "Headphones",
      imageType: "main_white_front",
    });
    expect(p).not.toMatch(/\S+ 色 \S+ 材质/);
    expect(p).not.toMatch(/(^|，)\S+ 色/);
    expect(p).not.toMatch(/(^|，)\S+ 材质/);
  });

  it("includes color + material when both are provided", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "main_white_front",
      color: "黑",
      material: "聚酯纤维",
    });
    expect(p).toContain("黑 色 聚酯纤维 材质");
  });

  it("falls back to 1:1 when aspectRatio is 'custom' without W/H", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "main_white_front",
      aspectRatio: "custom",
    });
    expect(p).toContain("1:1 比例");
  });

  it("formats custom W/H when aspectRatio is 'custom'", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "main_white_front",
      aspectRatio: "custom",
      customAspectW: 5,
      customAspectH: 7,
    });
    expect(p).toContain("5:7 比例");
  });

  it("uses the provided resolution verbatim", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "main_white_front",
      resolution: "2048x2048",
    });
    expect(p).toContain("2048x2048 分辨率");
  });

  it("renders a custom (free-text) imageType through the custom template", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "赛博朋克霓虹夜景",
    });
    expect(p).toContain("风格：赛博朋克霓虹夜景");
    expect(p).toContain("产品主体严格参考图 1");
  });

  it("appends customTypes as an 附加要求 clause", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "main_white_front",
      customTypes: ["突出品牌 logo", "柔和投影"],
    });
    expect(p).toContain("附加要求：突出品牌 logo；柔和投影");
  });

  it("skips customTypes that are blank", () => {
    const p = buildImagePrompt({
      ...BASE,
      imageType: "main_white_front",
      customTypes: ["", "  "],
    });
    expect(p).not.toContain("附加要求");
  });

  it("defaults productName to '该产品' when empty", () => {
    const p = buildImagePrompt({
      ...BASE,
      productName: "   ",
      imageType: "main_white_front",
    });
    expect(p).toContain("该产品");
  });

  it("wraps Chinese prompts with both a head and tail Chinese-only directive", () => {
    const p = buildImagePrompt({ ...BASE, imageType: "main_white_front" });
    expect(p.startsWith("语言=简体中文")).toBe(true);
    expect(p).toContain("全部必须使用简体中文");
    expect(p).toContain("最后提醒");
    expect(p).toContain("不得直接保留英文字符。");
  });
});

describe("buildImagePrompt — targetLanguage = 'en'", () => {
  const EN_BASE = { ...BASE, targetLanguage: "en" as const };

  it("produces a stable English prompt for each of the 10 built-in image types", () => {
    const keys = Object.keys(IMAGE_TYPE_LABELS) as ImageTypeKey[];
    const snapshot: Record<string, string> = {};
    for (const key of keys) {
      snapshot[key] = buildImagePrompt({ ...EN_BASE, imageType: key });
    }
    expect(snapshot).toMatchSnapshot();
  });

  it("wraps English prompts with both a head and tail English-only directive", () => {
    const p = buildImagePrompt({ ...EN_BASE, imageType: "main_white_front" });
    expect(p.startsWith("LANGUAGE=EN.")).toBe(true);
    expect(p).toContain("MUST be written in English only");
    expect(p).toContain("Final reminder");
    expect(p).toContain("even if the source product description contains them.");
  });

  it("embeds 30 / 45 / 90 angle into the English side-view template", () => {
    expect(
      buildImagePrompt({ ...EN_BASE, imageType: "side_30" }),
    ).toContain("product at a 30-degree side angle");
    expect(
      buildImagePrompt({ ...EN_BASE, imageType: "side_45" }),
    ).toContain("product at a 45-degree side angle");
    expect(
      buildImagePrompt({ ...EN_BASE, imageType: "side_90" }),
    ).toContain("product at a 90-degree side angle");
  });

  it("switches side-view reference clause based on hasStructureImage (EN)", () => {
    const withStruct = buildImagePrompt({
      ...EN_BASE,
      imageType: "side_45",
      hasStructureImage: true,
    });
    const withoutStruct = buildImagePrompt({
      ...EN_BASE,
      imageType: "side_45",
      hasStructureImage: false,
    });
    expect(withStruct).toContain(
      "Reference the provided 'structure / back view' image to reproduce accurate side details",
    );
    expect(withoutStruct).toContain("Infer reasonably from image 1");
  });

  it("renders the English custom template for free-text imageType", () => {
    const p = buildImagePrompt({
      ...EN_BASE,
      imageType: "cyberpunk neon night scene",
    });
    expect(p).toContain("style: cyberpunk neon night scene");
    expect(p).toContain("Reference image 1 strictly for the product");
  });

  it("joins customTypes with '; ' in English mode", () => {
    const p = buildImagePrompt({
      ...EN_BASE,
      imageType: "main_white_front",
      customTypes: ["emphasise brand logo", "soft shadow"],
    });
    expect(p).toContain(
      "Additional requirements: emphasise brand logo; soft shadow",
    );
  });

  it("includes color + material with English phrasing when both provided", () => {
    const p = buildImagePrompt({
      ...EN_BASE,
      imageType: "main_white_front",
      color: "black",
      material: "polyester",
    });
    expect(p).toContain("black color, polyester material");
  });

  it("defaults English productName to 'the product' when empty", () => {
    const p = buildImagePrompt({
      ...EN_BASE,
      productName: "   ",
      imageType: "main_white_front",
    });
    expect(p).toContain("the product");
  });

  it("never emits Chinese-only directive tokens in the EN prompt", () => {
    const p = buildImagePrompt({ ...EN_BASE, imageType: "selling_point" });
    expect(p).not.toContain("语言=简体中文");
    expect(p).not.toContain("硬性要求");
    expect(p).not.toContain("最后提醒");
  });
});

describe("buildImageCreationPrompt — on-image text count ranges", () => {
  const CREATION_BASE = {
    prompt: "A studio product hero shot",
    mainRefsCount: 1,
    aspectRatio: "1:1" as const,
    resolution: "1024x1024",
  };

  it.each([
    { density: "minimal" as const, lo: 8, hi: 16 },
    { density: "normal" as const, lo: 16, hi: 28 },
    { density: "rich" as const, lo: 28, hi: 40 },
  ])(
    "splices the ZH '$lo-$hi 个中文字符' band when textDensity=$density and lang=zh",
    ({ density, lo, hi }) => {
      const p = buildImageCreationPrompt({
        ...CREATION_BASE,
        targetLanguage: "zh",
        textDensity: density,
      });
      expect(p).toContain(`${lo}-${hi} 个中文字符`);
      expect(p).toContain(`不少于 ${lo}、不多于 ${hi}`);
    },
  );

  // 电商创作 (default variant): the EN image-creation path uses structural
  // composition guidance (headline / subheading / feature badges) rather than a
  // word-count band.
  it.each([
    {
      density: "minimal" as const,
      head: "DENSITY=MINIMAL: The image MUST contain ONLY ONE single primary marketing headline",
      tail: "keep exactly ONE primary headline and add no feature cards",
    },
    {
      density: "normal" as const,
      head: "DENSITY=NORMAL: The image MUST contain ONE main headline and EITHER one subheading OR roughly 2 to 3 concise feature badges",
      tail: "keep ONE main headline plus EITHER one subheading OR roughly 2 to 3 concise feature badges",
    },
    {
      density: "rich" as const,
      head: "DENSITY=RICH: The image MUST contain ONE main headline, ONE subheading, AND roughly 4 to 6 detailed feature labels",
      tail: "keep ONE main headline, ONE subheading, and roughly 4 to 6 feature labels",
    },
  ])(
    "ecommerce variant splices the EN structural composition directive when textDensity=$density and lang=en",
    ({ density, head, tail }) => {
      const p = buildImageCreationPrompt({
        ...CREATION_BASE,
        targetLanguage: "en",
        textDensity: density,
        imageCreationVariant: "ecommerce",
      });
      expect(p).toContain(head);
      expect(p).toContain(tail);
      // No word-count band on the e-commerce structural path.
      expect(p).not.toMatch(/\d+-\d+ words/);
    },
  );

  // 通用创作 (general variant): unchanged — keeps the legacy EN word-count band.
  it.each([
    { density: "minimal" as const, lo: 3, hi: 8 },
    { density: "normal" as const, lo: 8, hi: 16 },
    { density: "rich" as const, lo: 16, hi: 32 },
  ])(
    "general variant keeps the EN '$lo-$hi words' band when textDensity=$density and lang=en",
    ({ density, lo, hi }) => {
      const p = buildImageCreationPrompt({
        ...CREATION_BASE,
        targetLanguage: "en",
        textDensity: density,
        imageCreationVariant: "general",
      });
      expect(p).toContain(`${lo}-${hi} words`);
      expect(p).toContain(`not below ${lo}, not above ${hi}`);
      // General creation must NOT receive the e-commerce marketing directive.
      expect(p).not.toContain("primary marketing headline");
      expect(p).not.toContain("feature badges");
    },
  );

  it("emits the no-text directive when textDensity=none, regardless of language", () => {
    const p = buildImageCreationPrompt({
      ...CREATION_BASE,
      targetLanguage: "zh",
      textDensity: "none",
    });
    expect(p).toContain("do NOT render any text");
    // No count band should be spliced when text is suppressed entirely.
    expect(p).not.toMatch(/\d+-\d+ 个中文字符/);
    expect(p).not.toMatch(/\d+-\d+ words/);
  });
});

// 站点语言：marketplaceLanguage 设置后，legacy 渲染路径同样以站点商城语言
// 硬指令替换"跟随提示词语言"基座（与 structured 渲染器同源指令函数）。
describe("buildImageCreationPrompt — marketplace site language", () => {
  const CREATION_BASE_LEGACY = {
    prompt: "产品图1 上有个人在骑这个电动车",
    mainRefsCount: 1,
    aspectRatio: "1:1" as const,
    resolution: "1024x1024",
  };

  it("site=AMAZON_MX → 头部 LANGUAGE=SPANISH 硬指令，尾部同语言复查", () => {
    const p = buildImageCreationPrompt({
      ...CREATION_BASE_LEGACY,
      targetLanguage: "en",
      marketplaceLanguage: {
        site: "AMAZON_MX",
        locale: "es-MX",
        languageEn: "Spanish",
        languageZh: "西班牙语",
      },
    });
    expect(p).toContain("LANGUAGE=SPANISH (ES-MX). STRICT RULE:");
    expect(p).toContain("translate all on-image copy into Spanish");
    expect(p).toContain("must be in Spanish (es-MX)");
    expect(p).not.toContain("follow whatever language the user's brief uses");
  });

  it("site 覆盖 targetLanguage=zh 的中文硬指令", () => {
    const p = buildImageCreationPrompt({
      ...CREATION_BASE_LEGACY,
      targetLanguage: "zh",
      marketplaceLanguage: {
        site: "AMAZON_US",
        locale: "en-US",
        languageEn: "English",
        languageZh: "英语",
      },
    });
    expect(p).toContain("LANGUAGE=ENGLISH (EN-US). STRICT RULE:");
    expect(p).not.toContain("语言=简体中文");
  });

  it("缺省不注入站点指令（现状不变）", () => {
    const p = buildImageCreationPrompt({
      ...CREATION_BASE_LEGACY,
      targetLanguage: "en",
    });
    expect(p).toContain("follow whatever language the user's brief uses");
  });
});
