import sharp from "sharp";

import { deliveryPlanForForm, finalizeGeneratedImage } from "./delivery-finalize";
import type { ProductImageGenerateForm } from "./types";

function form(over: Partial<ProductImageGenerateForm>): ProductImageGenerateForm {
  return {
    resolutionTier: "2K",
    ...over,
  } as ProductImageGenerateForm;
}

describe("deliveryPlanForForm gating", () => {
  it("自定义像素裁剪使用中心锚点，宽横幅仍走补边", () => {
    const cropped = deliveryPlanForForm(form({
      customSizeMode: "pixels", customAspectW: 1500, customAspectH: 1000,
    }))!;
    expect(cropped.strategy).toBe("nearby_crop");
    expect(cropped.finalizer).toMatchObject({ fit: "cover", anchor: "center" });
    const banner = deliveryPlanForForm(form({
      customSizeMode: "pixels", customAspectW: 970, customAspectH: 300,
    }))!;
    expect(banner.strategy).toBe("edge_extend");
    expect(banner.finalizer.fit).toBe("extend");
  });

  it("returns a plan only for explicit pixel targets", () => {
    expect(
      deliveryPlanForForm(
        form({ customSizeMode: "pixels", customAspectW: 970, customAspectH: 300 }),
      ),
    ).not.toBeNull();
  });

  it("returns null for ratio mode (legacy passthrough untouched)", () => {
    expect(
      deliveryPlanForForm(
        form({ customSizeMode: "ratio", customAspectW: 16, customAspectH: 9 }),
      ),
    ).toBeNull();
  });

  it("returns null when pixel dimensions are missing or zero", () => {
    expect(deliveryPlanForForm(form({ customSizeMode: "pixels" }))).toBeNull();
    expect(
      deliveryPlanForForm(
        form({ customSizeMode: "pixels", customAspectW: 0, customAspectH: 300 }),
      ),
    ).toBeNull();
  });

  it("scales the delivered size to the resolution tier (§7.5)", () => {
    // 970×300 @2K → long side max(2048, 970) = 2048, ratio preserved → 2048×633.
    const p = deliveryPlanForForm(
      form({ customSizeMode: "pixels", customAspectW: 970, customAspectH: 300 }),
    )!;
    expect(p.target.width).toBe(2048);
    expect(p.target.height).toBe(633);
    expect(p.finalizer.targetWidth).toBe(2048);
    expect(p.finalizer.targetHeight).toBe(633);
  });

  it("uses an alpha-aware 'auto' background (custom pixels carry no intent)", () => {
    // A square target → padded_crop; its background must defer to the source's
    // alpha rather than hard-flatten to white.
    const p = deliveryPlanForForm(
      form({ customSizeMode: "pixels", customAspectW: 300, customAspectH: 300 }),
    )!;
    expect(p.finalizer.background.type).toBe("auto");
  });
});

describe("finalizeGeneratedImage", () => {
  it("forces a data-URL image to the exact target size", async () => {
    const png = await sharp({
      create: { width: 1488, height: 448, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

    const p = deliveryPlanForForm(
      form({ customSizeMode: "pixels", customAspectW: 970, customAspectH: 300 }),
    )!;
    const result = await finalizeGeneratedImage(dataUrl, p);

    // 970×300 @2K delivers at the tier-scaled size (2048×633), not the raw px.
    expect(result.width).toBe(2048);
    expect(result.height).toBe(633);
    expect(result.qaStatus).toBe("pass");
    expect(result.mimeType).toMatch(/^image\//);

    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(633);
  });
});
