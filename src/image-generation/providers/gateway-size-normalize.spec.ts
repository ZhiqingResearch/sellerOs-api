// src/image-generation/providers/gateway-size-normalize.spec.ts
//
// 归一化模块单测(T1/T2):sharp 合成真实小图验证处理分支 —— 快路径跳过 /
// 仅裁比例 / 仅档位 / 双偏(ZQ-Image-2 实测场景)/ 上采样补档 / alpha 编码 /
// 输入上限 / 异常保原;目标尺寸计算与开关/豁免/下载失败兜底。

import sharp from "sharp";
import type { ProviderGenerateInput } from "../core/types";
import {
  DEFAULT_NORMALIZE_MAX_PIXELS,
  gatewayNormalizeTargetSize,
  normalizeGatewayArtifact,
  normalizeGatewayImage,
} from "./gateway-size-normalize";

async function pngBytes(
  width: number,
  height: number,
  opts: { alpha?: boolean } = {},
): Promise<Buffer> {
  const channels = opts.alpha ? 4 : 3;
  const background = opts.alpha
    ? { r: 120, g: 80, b: 200, alpha: 0.5 }
    : { r: 120, g: 80, b: 200 };
  return sharp({
    create: { width, height, channels, background },
  })
    .png()
    .toBuffer();
}

async function jpegBytes(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

async function metadataOf(dataUrl: string) {
  return sharp(Buffer.from(dataUrl.split(",")[1], "base64")).metadata();
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE;
  delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE_SKIP;
  delete process.env.IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS;
});

describe("normalizeGatewayImage (T1 纯函数)", () => {

  it("尺寸已一致 → null(免二次编码快路径)", async () => {
    expect(
      await normalizeGatewayImage({
        bytes: await pngBytes(2048, 1152),
        targetWidth: 2048,
        targetHeight: 1152,
      }),
    ).toBeNull();
  });

  it("输入超过 maxPixels → null 保原", async () => {
    expect(
      await normalizeGatewayImage({
        bytes: await pngBytes(512, 512),
        targetWidth: 512,
        targetHeight: 512,
        maxPixels: 1000,
      }),
    ).toBeNull();
  });

  it("非法字节(sharp 解析失败)→ null,不抛出", async () => {
    expect(
      await normalizeGatewayImage({
        bytes: Buffer.from("这根本不是一张图片"),
        targetWidth: 1024,
        targetHeight: 1024,
      }),
    ).toBeNull();
  });
});

describe("gatewayNormalizeTargetSize (T2 目标尺寸)", () => {
  const base: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
  > = { aspectRatio: "1:1", resolutionTier: "2K" };

  it("常规比例:档位长边 + 短边四舍五入(复用 core 档位常量)", () => {
    expect(gatewayNormalizeTargetSize({ ...base, aspectRatio: "16:9" })).toEqual({
      width: 2048,
      height: 1152,
    });
    expect(
      gatewayNormalizeTargetSize({ ...base, aspectRatio: "4:3", resolutionTier: "4K" }),
    ).toEqual({ width: 4096, height: 3072 });
  });

  it("custom ratio:按档位长边推导(i2i 1464:625 @2K → 2048×874)", () => {
    expect(
      gatewayNormalizeTargetSize({
        ...base,
        aspectRatio: "custom",
        customAspectW: 1464,
        customAspectH: 625,
        customSizeMode: "ratio",
      }),
    ).toEqual({ width: 2048, height: 874 });
  });

  it("pixels 模式:精确 customAspectW×H,唯一事实源", () => {
    expect(
      gatewayNormalizeTargetSize({
        ...base,
        aspectRatio: "custom",
        customAspectW: 1254,
        customAspectH: 1254,
        customSizeMode: "pixels",
        resolutionTier: "1K",
      }),
    ).toEqual({ width: 1254, height: 1254 });
  });
});

describe("normalizeGatewayArtifact (T3 接线入口)", () => {
  const input = (over: Partial<ProviderGenerateInput> = {}): ProviderGenerateInput => ({
    referenceImages: [],
    prompt: "一只马克杯",
    aspectRatio: "1:1",
    resolutionTier: "2K",
    resolution: "2048x2048",
    ...over,
  });

  function dataUrlOf(bytes: Buffer): string {
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }

  it("外链产物经 fetch 下载后归一", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => await pngBytes(1254, 1254),
    }) as unknown as typeof fetch;
    const outcome = await normalizeGatewayArtifact({
      url: "https://gw.example/artifact.png",
      modelId: "ZQ-Image-2",
      input: input({ aspectRatio: "16:9" }),
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.normalized.from).toBe("1254x1254");
  });

  it("尺寸已一致 → null(零开销)", async () => {
    expect(
      await normalizeGatewayArtifact({
        url: dataUrlOf(await pngBytes(2048, 1152)),
        modelId: "ZQ-Image-2",
        input: input({ aspectRatio: "16:9" }),
      }),
    ).toBeNull();
  });

  it("下载失败 → null 保原 URL(已成功的图不能丢)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    expect(
      await normalizeGatewayArtifact({
        url: "https://gw.example/artifact.png",
        modelId: "ZQ-Image-2",
        input: input({ aspectRatio: "16:9" }),
      }),
    ).toBeNull();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }) as unknown as typeof fetch;
    expect(
      await normalizeGatewayArtifact({
        url: "https://gw.example/artifact.png",
        modelId: "ZQ-Image-2",
        input: input({ aspectRatio: "16:9" }),
      }),
    ).toBeNull();
  });

  it("IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS 透传生效", async () => {
    process.env.IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS = "1000";
    expect(
      await normalizeGatewayArtifact({
        url: dataUrlOf(await pngBytes(1254, 1254)),
        modelId: "ZQ-Image-2",
        input: input({ aspectRatio: "16:9" }),
      }),
    ).toBeNull();
  });
});

describe("normalizeGatewayImage cropToRatio（只裁不放大，2026-09-22 降档交付口径）", () => {

  it("高产物 → 裁掉超高（2048x3072 → 2:3 → 2048x3072 比例已符 → 快路径 null）", async () => {
    expect(
      await normalizeGatewayImage({
        bytes: await pngBytes(2048, 3072),
        targetWidth: 2731,
        targetHeight: 4096,
        cropToRatio: 2 / 3,
      }),
    ).toBeNull();
  });

  it("小产物也不上采样：600x400 → 2:3 → 267x400（裁，不放大）", async () => {
    const out = await normalizeGatewayImage({
      bytes: await pngBytes(600, 400),
      targetWidth: 2731,
      targetHeight: 4096,
      cropToRatio: 2 / 3,
    });
    expect(out).toMatchObject({ from: "600x400", to: "267x400" });
    expect(out!.ops).not.toContain("upscale:lanczos3+sharpen");
  });
});

describe("normalizeGatewayArtifact cropToRatio 透传", () => {
  it("带 cropToRatio → 走只裁口径", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => await pngBytes(3072, 2048),
    }) as unknown as typeof fetch;
    const input = {
      referenceImages: [],
      prompt: "p",
      aspectRatio: "2:3" as const,
      resolutionTier: "4K" as const,
      resolution: "2731x4096",
    };
    const out = await normalizeGatewayArtifact({
      url: "https://gw.example/a.png",
      modelId: "gpt-image-2.5-flare",
      input,
      cropToRatio: 2 / 3,
    });
    expect(out?.normalized).toMatchObject({ from: "3072x2048", to: "1365x2048" });
  });
});

describe("统一只裁比例", () => {
  const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer()
  it("比例相同但分辨率不同，保持原始字节", async () => {
    expect(await normalizeGatewayImage({ bytes: await image(1600, 900), targetWidth: 4096, targetHeight: 2304 })).toBeNull()
  })
  it("比例不符只中心裁剪，不补档放大", async () => {
    const result = await normalizeGatewayImage({ bytes: await image(160, 120), targetWidth: 2048, targetHeight: 1152 })
    expect(result).toMatchObject({ from: "160x120", to: "160x90", ops: ["crop:centre", "reencode:jpeg"] })
  })
})
