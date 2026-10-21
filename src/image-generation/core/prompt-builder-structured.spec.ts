// src/server/image/prompt-builder-structured.test.ts
//
// v7 structured renderer tests. Kept in a separate file from the legacy
// `prompt-builder.test.ts` so the legacy snapshot file
// (`__snapshots__/prompt-builder.test.ts.snap`) cannot be accidentally touched
// by `vitest -u` runs that target only the structured renderer.

import {
  buildImageCreationPromptStructured,
  type BuildImageCreationPromptInput,
} from "./prompt-builder";
import type { BrandIdentitySnapshot, ProductInfoSnapshot } from "./types";

const BASE_INPUT: BuildImageCreationPromptInput = {
  prompt: "A studio product hero shot",
  aspectRatio: "1:1",
  resolution: "1024x1024",
  targetLanguage: "en",
};

// Canonical TEXT_FREE_BAN_TERMS — duplicated here intentionally so we can
// detect any drift between the renderer's private list and what the test
// expects.
const EN_BAN_TERMS = [
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
];

describe("buildImageCreationPromptStructured — reference map", () => {
  it("[#1] singleton main + 1 attached → 'Image 1' + 'Image 2: attached'", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      mainRefsCount: 1,
      attachedRefsCount: 1,
    });
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    expect(built.prompt).not.toContain("Image 1-1");
    expect(built.prompt).toContain("Image 2: a user-attached reference image");
  });

  it("[#2] 2 main + 3 attached → ranges + numbered lines", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      mainRefsCount: 2,
      attachedRefsCount: 3,
    });
    // Each main ref gets its own labeled line now (used to be a single
    // "Image 1-2" range) so the LLM can resolve [产品图1] / [产品图2] to
    // specific images.
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    expect(built.prompt).toContain("Image 2 (labeled [产品图2]): product reference");
    expect(built.prompt).toContain("Image 3: a user-attached reference image");
    expect(built.prompt).toContain("Image 4: a user-attached reference image");
    expect(built.prompt).toContain("Image 5: a user-attached reference image");
  });

  it("[#3] 0 main + only attached → reference map starts at Image 1 (no main block)", () => {
    // Use compact renderLevel here: the priority block (full only) literally
    // says "main product references" inside its priority text, which would
    // false-positive a top-level "no main block" check. Compact preserves the
    // reference map but drops the priority block.
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 0,
        attachedRefsCount: 2,
      },
      { renderLevel: "compact" },
    );
    expect(built.prompt).not.toContain("main product reference");
    expect(built.prompt).not.toContain("Product references"); // mainHint
    expect(built.prompt).toContain("Image 1: a user-attached reference image");
    expect(built.prompt).toContain("Image 2: a user-attached reference image");
  });

  it("[#4] 0 attached refs (only main) → reference map has main only, no other lines", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      mainRefsCount: 1,
      attachedRefsCount: 0,
    });
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    expect(built.prompt).not.toContain("user-attached reference image");
  });

  it("[#4b] zero refs entirely (no main, no attached) → no reference map / no main hint", () => {
    // Compact renderLevel for the same reason as #3 — avoid the priority
    // block's "main product references" phrase masking the assertion.
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 0,
      },
      { renderLevel: "compact" },
    );
    expect(built.prompt).not.toContain("main product reference");
    expect(built.prompt).not.toContain("Product references"); // mainHint absent
    expect(built.prompt).not.toContain("Image 1:");
    expect(built.prompt).not.toContain("user-attached reference image");
  });
});

describe("buildImageCreationPromptStructured — text-free ban-term consistency", () => {
  // Helper: extract the set of TEXT_FREE_BAN_TERMS that appear in a section.
  // The renderer joins the canonical list with ", " in head and tail; we
  // simply check substring containment per term so the set comparison is
  // robust against whitespace / punctuation differences.
  const presentTerms = (section: string): Set<string> => {
    const out = new Set<string>();
    for (const term of EN_BAN_TERMS) {
      if (section.includes(term)) out.add(term);
    }
    return out;
  };

  // Slice the prompt into head and tail by splitting on the brief — the head
  // is everything before the brief, the tail is everything after the size
  // suffix. We use the brief text "[brief]" as a marker since structured
  // sections are joined with "\n\n".
  const splitHeadTail = (prompt: string, brief: string): { head: string; tail: string } => {
    const idx = prompt.indexOf(brief);
    if (idx === -1) {
      throw new Error("brief not found in prompt; test setup broken");
    }
    const head = prompt.slice(0, idx);
    const tail = prompt.slice(idx + brief.length);
    return { head, tail };
  };

  it("[#5] textDensity=none + brandNameZh '测试品牌' → output excludes brand name; head & tail mention wordmark / glyph / brand names", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      prompt: "marker brief 12345",
      textDensity: "none",
      brandIdentity: { brandNameZh: "测试品牌" },
    });
    expect(built.prompt).not.toContain("测试品牌");

    const { head, tail } = splitHeadTail(built.prompt, "marker brief 12345");
    expect(head).toContain("brand wordmarks");
    expect(head).toContain("glyphs");
    expect(head).toContain("brand names");
    expect(tail).toContain("brand wordmarks");
    expect(tail).toContain("glyphs");
    expect(tail).toContain("brand names");
  });

  it("[#6] head/tail none-branch keyword consistency — both sections enumerate the same TEXT_FREE_BAN_TERMS", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      prompt: "marker brief 12345",
      textDensity: "none",
    });
    const { head, tail } = splitHeadTail(built.prompt, "marker brief 12345");
    const headTerms = presentTerms(head);
    const tailTerms = presentTerms(tail);

    // Both sections must contain every canonical term.
    expect(headTerms.size).toBe(EN_BAN_TERMS.length);
    expect(tailTerms.size).toBe(EN_BAN_TERMS.length);
    // And the sets must be equal.
    expect([...headTerms].sort()).toEqual([...tailTerms].sort());
  });
});

describe("buildImageCreationPromptStructured — productInfo / brandIdentity coverage", () => {
  it("[#7] textDensity=rich + complete productInfo (all 19 fields incl. shelfLife) → every non-empty field appears", () => {
    const productInfo: ProductInfoSnapshot = {
      productName: "Hydrating Face Serum X",
      targetCountry: ["US"],
      ecommercePlatform: ["Amazon"],
      categoryL1: "Beauty",
      categoryL2: "Skincare",
      spec: "30ml glass bottle",
      size: "30ml",
      coreSellingPoints: ["72-hour hydration", "Lightweight texture", "Non-comedogenic"],
      certifications: ["FDA-registered", "Cruelty-free"],
      audiencePersona: "Skincare enthusiasts age 25-40",
      ageGroup: "25-40",
      consumerTier: "Premium",
      ingredients: "Hyaluronic acid, niacinamide, vitamin B5",
      usageInstructions: "Apply 2-3 drops to clean skin morning and evening.",
      shelfLife: "24 months",
      textureFinish: "Silky lightweight gel",
      structureFeature: "Glass bottle with dropper",
      packagingFeature: "Recyclable carton",
      productDescription: "A premium hydrating serum formulated for daily use.",
    };
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        textDensity: "rich",
        productInfo,
      },
      { renderLevel: "full" },
    );

    // Spot-check every populated field.
    expect(built.prompt).toContain("Hydrating Face Serum X");
    expect(built.prompt).toContain("Designed for US Amazon listings.");
    expect(built.prompt).toContain("Beauty Skincare");
    expect(built.prompt).toContain("30ml glass bottle");
    expect(built.prompt).toContain("30ml");
    expect(built.prompt).toContain("72-hour hydration");
    expect(built.prompt).toContain("FDA-registered");
    expect(built.prompt).toContain("Skincare enthusiasts age 25-40");
    expect(built.prompt).toContain("25-40");
    expect(built.prompt).toContain("Premium");
    expect(built.prompt).toContain("Hyaluronic acid");
    expect(built.prompt).toContain("Apply 2-3 drops");
    expect(built.prompt).toContain("24 months");
    expect(built.prompt).toContain("Silky lightweight gel");
    expect(built.prompt).toContain("Glass bottle with dropper");
    expect(built.prompt).toContain("Recyclable carton");
    expect(built.prompt).toContain("A premium hydrating serum");
  });

  it("[#7a] productInfo.attributes[] (new schema) → unified 'Product attributes' line carries every K/V pair", () => {
    const productInfo: ProductInfoSnapshot = {
      productName: "Stanley Quencher H2.0",
      attributes: [
        { key: "材质", value: "18/8 不锈钢" },
        { key: "容量", value: "40 oz (约 1.18L)" },
        { key: "颜色", value: "Charcoal · Polar" },
      ],
    };
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, textDensity: "rich", productInfo },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("Product attributes");
    expect(built.prompt).toContain("材质: 18/8 不锈钢");
    expect(built.prompt).toContain("容量: 40 oz (约 1.18L)");
    expect(built.prompt).toContain("颜色: Charcoal · Polar");
  });

  it("[#7b] attributes overrides legacy on duplicate canonical key (新 attribute 优先级高于旧 spec)", () => {
    const productInfo: ProductInfoSnapshot = {
      productName: "Widget",
      // Legacy field — will be auto-mapped to "规格".
      spec: "OLD-SPEC-DROP",
      // New attribute uses the same canonical key — should win.
      attributes: [{ key: "规格", value: "NEW-SPEC-KEEP" }],
    };
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, textDensity: "rich", productInfo },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("规格: NEW-SPEC-KEEP");
    expect(built.prompt).not.toContain("OLD-SPEC-DROP");
  });

  it("[#7c] only legacy平铺字段 (no attributes[]) → still emits via unified 商品属性 line (back-compat)", () => {
    const productInfo: ProductInfoSnapshot = {
      productName: "Widget",
      spec: "500ml glass bottle",
      ingredients: "Vitamin C, Zinc",
      // No attributes[] — pure legacy record.
    };
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, textDensity: "rich", productInfo },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("Product attributes");
    expect(built.prompt).toContain("规格: 500ml glass bottle");
    expect(built.prompt).toContain("成分: Vitamin C, Zinc");
  });

  it("[#8] productDescription length 500 chars → rendered ≤ 200 chars in the product block", () => {
    const longDesc = "x".repeat(500);
    const productInfo: ProductInfoSnapshot = {
      productName: "Widget",
      productDescription: longDesc,
    };
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, productInfo },
      { renderLevel: "full" },
    );
    // Find the longest "x..." run in the prompt — it must be ≤ 200.
    const xRun = built.prompt.match(/x{50,}/);
    expect(xRun).not.toBeNull();
    expect((xRun?.[0].length ?? 0)).toBeLessThanOrEqual(200);
  });

  it("[#11] coreSellingPoints with 8 items → only first 5 appear in prompt", () => {
    const productInfo: ProductInfoSnapshot = {
      productName: "Widget",
      coreSellingPoints: ["sp1", "sp2", "sp3", "sp4", "sp5", "sp6", "sp7", "sp8"],
    };
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, productInfo },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("sp1");
    expect(built.prompt).toContain("sp5");
    expect(built.prompt).not.toContain("sp6");
    expect(built.prompt).not.toContain("sp7");
    expect(built.prompt).not.toContain("sp8");
  });

  it("[#12] targetCountry=US + ecommercePlatform=Amazon → 'Designed for US Amazon listings.'", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        productInfo: {
          productName: "Widget",
          targetCountry: ["US"],
          ecommercePlatform: ["Amazon"],
        },
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("Designed for US Amazon listings.");
  });

  it("[#13] only targetCountry=US (no platform) → labeled fact, NOT joint sentence", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        productInfo: {
          productName: "Widget",
          targetCountry: ["US"],
        },
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("Designed for US");
    // The labeled fact form: "Target market: US"
    expect(built.prompt).toContain("Target market: US");
  });
});

describe("buildImageCreationPromptStructured — brief truncation", () => {
  it("[#9] userPrompt 800 chars latin → '[brief truncated]'; meta.truncated=true; meta.originalBriefLength=800", () => {
    const longBrief = "a".repeat(800);
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      prompt: longBrief,
    });
    expect(built.prompt).toContain("[brief truncated]");
    expect(built.meta.truncated).toBe(true);
    expect(built.meta.originalBriefLength).toBe(800);
  });

  it("[#10] userPrompt 800 chars chinese + targetLanguage=zh → '[简介已截断]'; meta same shape", () => {
    const longBrief = "测".repeat(800);
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      prompt: longBrief,
      targetLanguage: "zh",
    });
    expect(built.prompt).toContain("[简介已截断]");
    expect(built.meta.truncated).toBe(true);
    expect(built.meta.originalBriefLength).toBe(800);
  });

  it("brief at exactly 500 chars → not truncated", () => {
    const brief = "a".repeat(500);
    const built = buildImageCreationPromptStructured({ ...BASE_INPUT, prompt: brief });
    expect(built.meta.truncated).toBe(false);
    expect(built.prompt).not.toContain("[brief truncated]");
  });
});

describe("buildImageCreationPromptStructured — renderLevel switching", () => {
  // A reusable input that populates every section so we can detect what
  // renderLevel emits / suppresses.
  const RICH_INPUT: BuildImageCreationPromptInput = {
    prompt: "marker brief XYZ",
    mainRefsCount: 1,
    attachedRefsCount: 1,
    aspectRatio: "1:1",
    resolution: "1024x1024",
    targetLanguage: "en",
    productInfo: {
      productName: "Widget",
      coreSellingPoints: ["fast", "durable"],
    },
    brandIdentity: { brandNameEn: "WidgetCo", primaryColors: ["#000000"] },
  };

  it("[#14] renderLevel=full → all sections present (priority + product + brand blocks)", () => {
    const built = buildImageCreationPromptStructured(RICH_INPUT, { renderLevel: "full" });
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    expect(built.prompt).toContain("Image 2: a user-attached reference image");
    expect(built.prompt).toContain("Product facts");
    expect(built.prompt).toContain("Widget");
    expect(built.prompt).toContain("Brand identity");
    expect(built.prompt).toContain("WidgetCo");
    expect(built.prompt).toContain("Aspect ratio 1:1");
    expect(built.prompt).toContain("priority order");
    expect(built.prompt).toContain("(1) Preserve the product identity");
  });

  it("[#15] renderLevel=compact → no product/brand/priority; has head + main hint + ref map + brief + size + tail", () => {
    const built = buildImageCreationPromptStructured(RICH_INPUT, { renderLevel: "compact" });
    expect(built.prompt).not.toContain("Product facts");
    expect(built.prompt).not.toContain("Brand identity");
    expect(built.prompt).not.toContain("priority order");
    expect(built.prompt).not.toContain("(1) Preserve the product identity");
    // But these MUST be present:
    expect(built.prompt).toContain("Product references (1)");
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    expect(built.prompt).toContain("Image 2: a user-attached reference image");
    expect(built.prompt).toContain("marker brief XYZ");
    expect(built.prompt).toContain("Aspect ratio 1:1");
  });

  it("[#16] renderLevel=minimal → only head + brief + tail; no reference map, product, brand, priority", () => {
    const built = buildImageCreationPromptStructured(RICH_INPUT, { renderLevel: "minimal" });
    expect(built.prompt).toContain("marker brief XYZ");
    expect(built.prompt).not.toContain("Image 1");
    expect(built.prompt).not.toContain("Image 2");
    expect(built.prompt).not.toContain("Product references");
    expect(built.prompt).not.toContain("Product facts");
    expect(built.prompt).not.toContain("Brand identity");
    expect(built.prompt).not.toContain("priority order");
    expect(built.prompt).not.toContain("Aspect ratio 1:1");
  });
});

describe("buildImageCreationPromptStructured — priority block", () => {
  it("[#17a] EN priority block → 5 numbered lines starting with the canonical first line", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "brief" },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("(1) Preserve the product identity from the product references.");
    expect(built.prompt).toContain("(2) Follow the on-image text and language rules.");
    expect(built.prompt).toContain("(3) Use only provided product and brand facts; do not invent missing facts.");
    expect(built.prompt).toContain("(4) Use auxiliary references only for their assigned roles.");
    expect(built.prompt).toContain("(5) Follow the user creative brief where it does not conflict with the above.");
  });

  it("[#17b] ZH priority block → 5 numbered lines starting with canonical first line", () => {
    const built = buildImageCreationPromptStructured(
      {
        prompt: "brief",
        aspectRatio: "1:1",
        resolution: "1024x1024",
        targetLanguage: "zh",
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("（1）优先保持产品图中的产品身份一致。");
    expect(built.prompt).toContain("（2）优先遵守图中文字和语言规则。");
    expect(built.prompt).toContain("（3）仅使用已提供的产品事实和品牌事实，不编造缺失信息。");
    expect(built.prompt).toContain("（4）附加参考图只在其指定角色内生效。");
    expect(built.prompt).toContain("（5）用户创意描述只在不冲突时生效。");
  });
});

describe("buildImageCreationPromptStructured — customSizeMode pixels", () => {
  it("[#18] customSizeMode=pixels + aspectRatio=custom + 1600/2000 → 'Output dimensions: 1600:2000 pixels', NOT 'Aspect ratio'", () => {
    const built = buildImageCreationPromptStructured(
      {
        prompt: "brief",
        aspectRatio: "custom",
        customAspectW: 1600,
        customAspectH: 2000,
        customSizeMode: "pixels",
        resolution: "1600x2000",
        targetLanguage: "en",
      },
      { renderLevel: "compact" }, // compact still emits sizeSuffix
    );
    expect(built.prompt).toContain("Output dimensions: 1600:2000 pixels");
    // The English size suffix in non-pixel mode would say "Aspect ratio ..."
    // so we must not see that wording.
    expect(built.prompt).not.toContain("Aspect ratio 1600:2000");
    expect(built.prompt).not.toContain("Aspect ratio custom");
  });

  it("[#18b] customSizeMode=pixels in zh → '输出像素尺寸：W:H' wording", () => {
    const built = buildImageCreationPromptStructured(
      {
        prompt: "brief",
        aspectRatio: "custom",
        customAspectW: 1600,
        customAspectH: 2000,
        customSizeMode: "pixels",
        resolution: "1600x2000",
        targetLanguage: "zh",
      },
      { renderLevel: "compact" },
    );
    expect(built.prompt).toContain("输出像素尺寸：1600:2000");
    expect(built.prompt).not.toContain("1600:2000 比例");
  });
});

describe("buildImageCreationPromptStructured — metadata shape", () => {
  it("[#19] meta.version=structured; meta.renderLevel matches options; lengths populated", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "short brief" },
      { renderLevel: "compact" },
    );
    expect(built.meta.version).toBe("structured");
    if (built.meta.version === "structured") {
      expect(built.meta.renderLevel).toBe("compact");
    }
    expect(built.meta.truncated).toBe(false);
    expect(built.meta.originalBriefLength).toBe("short brief".length);
    expect(built.meta.finalPromptLength).toBe(built.prompt.length);
    expect(built.meta.finalPromptLength).toBeGreaterThan(0);
  });

  it("renderLevel defaults to 'full' when options is omitted", () => {
    const built = buildImageCreationPromptStructured({ ...BASE_INPUT, prompt: "x" });
    expect(built.meta.version).toBe("structured");
    if (built.meta.version === "structured") {
      expect(built.meta.renderLevel).toBe("full");
    }
  });

  it("brandIdentity skips brandName + fontStyle when textDensity=none", () => {
    const brand: BrandIdentitySnapshot = {
      brandNameEn: "ShouldNotAppear",
      brandNameZh: "也不应该出现",
      fontStyle: "Sans-serif elegant",
      primaryColors: ["#FF0000"],
    };
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        prompt: "brief",
        textDensity: "none",
        brandIdentity: brand,
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("ShouldNotAppear");
    expect(built.prompt).not.toContain("也不应该出现");
    expect(built.prompt).not.toContain("Sans-serif elegant");
    // primaryColors should still appear.
    expect(built.prompt).toContain("#FF0000");
  });
});

describe("buildImageCreationPromptStructured — product consistency directive", () => {
  it("full + mainRefsCount=1 (en) → contains 'PRODUCT CONSISTENCY' hard rule", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, mainRefsCount: 1 },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("PRODUCT CONSISTENCY");
    expect(built.prompt).toMatch(/shape, proportions, color, material/);
  });

  it("full + mainRefsCount=2 (zh) → contains '产品一致性' hard rule", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, targetLanguage: "zh", mainRefsCount: 2 },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("产品一致性");
    expect(built.prompt).toContain("形状、比例、颜色、材质");
  });

  it("compact + mainRefsCount=1 → still contains consistency directive (hard rule, not droppable)", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, mainRefsCount: 1 },
      { renderLevel: "compact" },
    );
    expect(built.prompt).toContain("PRODUCT CONSISTENCY");
  });

  it("minimal + mainRefsCount=1 → does NOT contain consistency directive (minimal is fallback)", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, mainRefsCount: 1 },
      { renderLevel: "minimal" },
    );
    expect(built.prompt).not.toContain("PRODUCT CONSISTENCY");
    expect(built.prompt).not.toContain("产品一致性");
  });

  it("full + mainRefsCount=0 → does NOT contain consistency directive (no anchor reference)", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, mainRefsCount: 0 },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("PRODUCT CONSISTENCY");
    expect(built.prompt).not.toContain("产品一致性");
  });

  it("consistency directive appears AFTER mainHint and BEFORE reference map (full)", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 2,
        attachedRefsCount: 1,
      },
      { renderLevel: "full" },
    );
    const mainHintIdx = built.prompt.indexOf("Product references (2)");
    const consistencyIdx = built.prompt.indexOf("PRODUCT CONSISTENCY");
    const refMapIdx = built.prompt.indexOf("Image 1 (labeled [产品图1])");
    expect(mainHintIdx).toBeGreaterThanOrEqual(0);
    expect(consistencyIdx).toBeGreaterThan(mainHintIdx);
    expect(refMapIdx).toBeGreaterThan(consistencyIdx);
  });
});

describe("buildImageCreationPromptStructured — explicit chip↔image binding", () => {
  it("main refs are labeled per-image so [产品图N] resolves to a specific reference image", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, mainRefsCount: 2, attachedRefsCount: 0 },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    expect(built.prompt).toContain("Image 2 (labeled [产品图2]): product reference");
    // No range form anymore (used to be "Image 1-2: main product references")
    expect(built.prompt).not.toContain("Image 1-2");
  });

  it("generated-source attached refs carry the [生成图N] anchor in the ref map", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 1,
        attachedRefsCount: 2,
        attachedRefsSources: ["generated", "paperclip"],
        attachedRefsChipNumbers: [7, null],
      },
      { renderLevel: "full" },
    );
    // The generated ref (file index 0 → Image 2 in the array) carries the
    // [生成图7] anchor; the paperclip ref (file index 1 → Image 3) has no
    // chipNumber so it falls back to the generic reference description.
    expect(built.prompt).toContain(
      'Image 2 (labeled [生成图7] — when the user prompt mentions "[生成图7]" it refers to this specific image)',
    );
    expect(built.prompt).toContain("a previously generated frame");
    expect(built.prompt).toContain("Image 3: a user-attached reference image");
  });

  it("multiple generated refs all get distinct chip anchors (non-sequential N supported)", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 0,
        attachedRefsCount: 2,
        attachedRefsSources: ["generated", "generated"],
        // Non-sequential N (e.g. user deleted some chips, counter kept going)
        attachedRefsChipNumbers: [3, 7],
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("[生成图3]");
    expect(built.prompt).toContain("[生成图7]");
    // Order matches submission order: first generated ref is Image 1
    const idx3 = built.prompt.indexOf("[生成图3]");
    const idx7 = built.prompt.indexOf("[生成图7]");
    expect(idx3).toBeGreaterThan(-1);
    expect(idx7).toBeGreaterThan(idx3);
  });

  it("zh prompt emits 中文 chip anchors", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        targetLanguage: "zh",
        mainRefsCount: 1,
        attachedRefsCount: 1,
        attachedRefsSources: ["generated"],
        attachedRefsChipNumbers: [5],
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("图 1（即 [产品图1]）：产品参考图");
    expect(built.prompt).toContain(
      '（即 [生成图5] —— 用户提示词中出现 "[生成图5]" 即指本图）',
    );
    expect(built.prompt).toContain("之前生成的图作为参考");
  });

  it("paperclip-source refs WITHOUT chipNumber render unlabeled — legacy back-compat path", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 0,
        attachedRefsCount: 1,
        attachedRefsSources: ["paperclip"],
        attachedRefsChipNumbers: [null],
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("Image 1: a user-attached reference image");
    expect(built.prompt).not.toContain("labeled");
  });

  it("paperclip-source refs WITH chipNumber carry the [图N] anchor (post-2026-05)", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 0,
        attachedRefsCount: 2,
        attachedRefsSources: ["paperclip", "paperclip"],
        attachedRefsChipNumbers: [3, 8],
      },
      { renderLevel: "full" },
    );
    // Each paperclip ref with a chipNumber gets a [图N] anchor binding to
    // a specific Image slot.
    expect(built.prompt).toContain(
      'Image 1 (labeled [图3] — when the user prompt mentions "[图3]" it refers to this specific image)',
    );
    expect(built.prompt).toContain(
      'Image 2 (labeled [图8] — when the user prompt mentions "[图8]" it refers to this specific image)',
    );
    // Chip-labeled refs never emit the unlabeled fallback line.
    expect(built.prompt).not.toContain("Image 1: a user-attached reference image");
    expect(built.prompt).not.toContain("Image 2: a user-attached reference image");
  });

  it("zh paperclip-source refs with chipNumber emit 中文 [图N] anchors", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        targetLanguage: "zh",
        mainRefsCount: 0,
        attachedRefsCount: 1,
        attachedRefsSources: ["paperclip"],
        attachedRefsChipNumbers: [2],
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain(
      '图 1（即 [图2] —— 用户提示词中出现 "[图2]" 即指本图）',
    );
    expect(built.prompt).toContain("综合借鉴其视觉元素");
  });

  it("legacy callers (no sources / chipNumbers) get unlabeled ref lines — back-compat", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        mainRefsCount: 1,
        attachedRefsCount: 1,
        // sources + chipNumbers omitted (legacy)
      },
      { renderLevel: "full" },
    );
    // Main refs always get the [产品图N] label now (it's safe — anchors a
    // chip that may exist in the user's prompt even from legacy callers).
    expect(built.prompt).toContain("Image 1 (labeled [产品图1]): product reference");
    // Attached refs without source info render plain.
    expect(built.prompt).toContain("Image 2: a user-attached reference image");
  });
});

describe("buildImageCreationPromptStructured — applyBrandColor gate + default-palette framing (MAGA §3.4/§4.1)", () => {
  const brandWithColors = (
    applyBrandColor?: boolean,
  ): BrandIdentitySnapshot => ({
    brandNameEn: "WidgetCo",
    primaryColors: ["#E63946", "#457B9D"],
    designStyles: ["minimal"],
    applyBrandColor,
  });

  it("[#brand-color-1] applyBrandColor undefined (default on) → 主色 line emitted with default-palette wording (en)", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "brief", brandIdentity: brandWithColors(undefined) },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain(
      "Brand colors (default palette — if the brief or selected template specifies colors, follow those): #E63946, #457B9D",
    );
    // Other brand facts unaffected.
    expect(built.prompt).toContain("WidgetCo");
    expect(built.prompt).toContain("Design styles: minimal");
  });

  it("[#brand-color-2] applyBrandColor=false → 主色 line dropped, other brand facts + names kept", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "brief", brandIdentity: brandWithColors(false) },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("Brand colors");
    expect(built.prompt).not.toContain("#E63946");
    expect(built.prompt).not.toContain("#457B9D");
    // The block itself + non-color facts must still be present.
    expect(built.prompt).toContain("Brand identity");
    expect(built.prompt).toContain("WidgetCo");
    expect(built.prompt).toContain("Design styles: minimal");
  });

  it("[#brand-color-3] colors active → priority rule (6) about color precedence is appended", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "brief", brandIdentity: brandWithColors(true) },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain(
      "(6) If the user brief or the selected template/scheme specifies colors, those colors take precedence",
    );
  });

  it("[#brand-color-4] applyBrandColor=false → no color-precedence rule (nothing to qualify)", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "brief", brandIdentity: brandWithColors(false) },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("those colors take precedence");
    // Canonical 5-rule block still intact.
    expect(built.prompt).toContain("(5) Follow the user creative brief");
  });

  it("[#brand-color-5] no brand colors at all → no color-precedence rule", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        prompt: "brief",
        brandIdentity: { brandNameEn: "WidgetCo", designStyles: ["minimal"] },
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("those colors take precedence");
    expect(built.prompt).not.toContain("Brand colors");
  });

  it("[#bridge-1] product/brand facts present → priority block bridges brief references to the fact blocks", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        prompt: "突出核心卖点",
        targetLanguage: "zh",
        productInfo: { productName: "Widget", coreSellingPoints: ["快", "耐用"] },
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain(
      "当创意中提到产品资料或品牌基因里的字段",
    );
  });

  it("[#bridge-2] no product/brand facts → no bridge rule (nothing to bind)", () => {
    const built = buildImageCreationPromptStructured(
      { ...BASE_INPUT, prompt: "a hero shot", targetLanguage: "zh" },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("当创意中提到产品资料或品牌基因里的字段");
  });

  it("[#brand-coverage-1] colors emitted → 主色 carries a position+coverage directive (background dominant, not text-first)", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        prompt: "brief",
        targetLanguage: "zh",
        brandIdentity: brandWithColors(true),
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("品牌色系应在画面中占主导（背景优先着色）");
    expect(built.prompt).toContain("大面积背景/色块着色优先于文字着色");
  });

  it("[#brand-coverage-2] applyBrandColor=false → no coverage directive (gated with the 主色 line)", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        prompt: "brief",
        targetLanguage: "zh",
        brandIdentity: brandWithColors(false),
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).not.toContain("品牌色系应在画面中占主导");
  });

  it("[#brand-logo] brand-logo source → dedicated ref-map line naming THIS image as the logo", () => {
    const built = buildImageCreationPromptStructured(
      {
        prompt: "把品牌 LOGO 放在右上角",
        aspectRatio: "1:1",
        resolution: "1024x1024",
        targetLanguage: "zh",
        mainRefsCount: 1,
        mainRefsLabels: ["产品"],
        attachedRefsCount: 1,
        attachedRefsSources: ["brand-logo"],
        attachedRefsChipNumbers: [null],
        attachedRefsChipTokens: [null],
      },
      { renderLevel: "full" },
    );
    // The logo is image 2 (after the 1 main product ref) and must be called
    // out explicitly, not folded into a generic "用户附加的参考图" line.
    expect(built.prompt).toContain("图 2：品牌 LOGO 图");
    expect(built.prompt).toContain("即指本图");
    expect(built.prompt).not.toContain("图 2（即 [图");
  });

  it("[#brand-color-6] ZH default-palette wording", () => {
    const built = buildImageCreationPromptStructured(
      {
        prompt: "brief",
        aspectRatio: "1:1",
        resolution: "1024x1024",
        targetLanguage: "zh",
        brandIdentity: { primaryColors: ["#E63946"] },
      },
      { renderLevel: "full" },
    );
    expect(built.prompt).toContain("主色（默认配色，若创意/所选模板另有指定则以指定为准）：#E63946");
    expect(built.prompt).toContain(
      "（6）若用户创意或所选模板/套图方案明确指定了配色，以指定配色为准；品牌主色仅在未指定配色时作为默认。",
    );
  });
});

// ── 站点语言（marketplaceLanguage）───────────────────────────────────────────
// 站点选择后图上文字语言由站点商城语言硬性决定（common/utils/marketplace-language
// 按国家码动态推导），优先于 targetLanguage 与"跟随提示词语言"规则；缺省时输出
// 与现状逐字节一致。
describe("buildImageCreationPromptStructured — marketplace site language", () => {
  const ZH_BRIEF = "产品图1 上有个人在骑这个电动车";

  it("site=AMAZON_MX → head 以 LANGUAGE=SPANISH (ES-MX) 硬指令开头，不再跟随提示词语言", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      prompt: ZH_BRIEF,
      marketplaceLanguage: {
        site: "AMAZON_MX",
        locale: "es-MX",
        languageEn: "Spanish",
        languageZh: "西班牙语",
      },
    });
    expect(built.prompt).toContain("LANGUAGE=SPANISH (ES-MX). STRICT RULE:");
    expect(built.prompt).toContain("MUST be written in Spanish only");
    expect(built.prompt).toContain("translate all on-image copy into Spanish");
    // 中文提示词原文保留（仍是创意种子），但语言规则不跟随它。
    expect(built.prompt).toContain(ZH_BRIEF);
    expect(built.prompt).not.toContain("follow whatever language the user's brief uses");
    // 尾部复查指令同语言。
    expect(built.prompt).toContain("must be in Spanish (es-MX)");
  });

  it("site 覆盖 targetLanguage=zh：不再输出中文硬性指令", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      prompt: ZH_BRIEF,
      targetLanguage: "zh",
      marketplaceLanguage: {
        site: "AMAZON_US",
        locale: "en-US",
        languageEn: "English",
        languageZh: "英语",
      },
    });
    expect(built.prompt).toContain("LANGUAGE=ENGLISH (EN-US). STRICT RULE:");
    expect(built.prompt).not.toContain("语言=简体中文");
  });

  it("textDensity=none 优先于站点语言：仍是无文字指令", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      textDensity: "none",
      marketplaceLanguage: {
        site: "AMAZON_MX",
        locale: "es-MX",
        languageEn: "Spanish",
        languageZh: "西班牙语",
      },
    });
    expect(built.prompt).toContain("TEXT-FREE OUTPUT REQUIRED");
    expect(built.prompt).not.toContain("LANGUAGE=SPANISH");
  });

  it("密度指令照常叠加（ecommerce normal 版式要求仍在）", () => {
    const built = buildImageCreationPromptStructured({
      ...BASE_INPUT,
      marketplaceLanguage: {
        site: "AMAZON_MX",
        locale: "es-MX",
        languageEn: "Spanish",
        languageZh: "西班牙语",
      },
    });
    expect(built.prompt).toContain("DENSITY=NORMAL: The image MUST contain ONE main headline");
    expect(built.prompt).toContain("2 to 3 concise feature badges");
  });

  it("缺省（无 marketplaceLanguage）→ 沿用跟随提示词语言规则（现状不变）", () => {
    const built = buildImageCreationPromptStructured({ ...BASE_INPUT });
    expect(built.prompt).toContain(
      "LANGUAGE: follow whatever language the user's brief uses for any text shown in the image; if the brief does not specify, default to English.",
    );
  });

  it("renderLevel=minimal 也保留头尾语言指令（硬规则不随渲染档降级）", () => {
    const built = buildImageCreationPromptStructured(
      {
        ...BASE_INPUT,
        marketplaceLanguage: {
          site: "AMAZON_JP",
          locale: "ja-JP",
          languageEn: "Japanese",
          languageZh: "日语",
        },
      },
      { renderLevel: "minimal" },
    );
    expect(built.prompt).toContain("LANGUAGE=JAPANESE (JA-JP). STRICT RULE:");
    expect(built.prompt).toContain("must be in Japanese (ja-JP)");
  });
});
