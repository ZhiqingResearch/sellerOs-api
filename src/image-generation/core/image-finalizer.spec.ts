import sharp from "sharp";

import { finalize, verifyDeliverySize } from "./image-finalizer";
import { buildFinalizerOptions } from "./delivery-planner";
import { TARGET_SIZE_REGISTRY } from "./target-size-registry";
import type { DeliveryStrategy, FinalizerOptions } from "./delivery-types";

/** A solid-colour image at an arbitrary (intentionally mismatched) size, with
 *  optional alpha so we can assert the flatten path. */
async function makeImage(
  width: number,
  height: number,
  rgb: [number, number, number],
  withAlpha = false,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: withAlpha ? 4 : 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: withAlpha ? 0.5 : 1 },
    },
  })
    .png()
    .toBuffer();
}

async function cornerPixel(
  buffer: Buffer,
): Promise<{ r: number; g: number; b: number; channels: number }> {
  const { data, info } = await sharp(buffer)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2], channels: info.channels };
}

const STRATEGIES: DeliveryStrategy[] = [
  "native",
  "nearby_crop",
  "padded_crop",
  "white_pad",
  "edge_extend",
];

// A spread of target shapes: square, wide banner, tall, small.
const TARGETS: Array<[number, number]> = [
  [970, 300],
  [300, 300],
  [135, 135],
  [150, 300],
  [1600, 1600],
];

function optsFor(
  strategy: DeliveryStrategy,
  w: number,
  h: number,
): FinalizerOptions {
  return buildFinalizerOptions(
    {
      id: "test",
      section: "custom",
      width: w,
      height: h,
      usage: "custom",
      backgroundIntent: "white",
      contentIntent: "product",
      allowWhitePadding: true,
      allowSubjectCrop: false,
      minWorkingLongSide: 1024,
    },
    strategy,
  );
}

describe("image-finalizer / size contract", () => {
  for (const strategy of STRATEGIES) {
    for (const [w, h] of TARGETS) {
      it(`${strategy} → exact ${w}x${h} from a mismatched source`, async () => {
        const source = await makeImage(640, 480, [200, 30, 30]);
        const opts = optsFor(strategy, w, h);
        const result = await finalize(source, opts);
        expect(result.width).toBe(w);
        expect(result.height).toBe(h);
        expect(verifyDeliverySize(result, opts).status).toBe("pass");
      });
    }
  }
});

describe("image-finalizer / alpha + background handling", () => {
  it("white_pad flattens alpha and pads with white (jpeg, 3 channels)", async () => {
    // tall red source into a wide target → left/right white bars
    const source = await makeImage(100, 400, [220, 20, 20], true);
    const opts = optsFor("white_pad", 400, 200);
    const result = await finalize(source, opts);
    expect(result.format).toBe("jpeg");
    const corner = await cornerPixel(result.buffer);
    expect(corner.channels).toBe(3); // no alpha
    expect(corner.r).toBeGreaterThan(245);
    expect(corner.g).toBeGreaterThan(245);
    expect(corner.b).toBeGreaterThan(245);
  });

  it("nearby_crop output has no alpha channel (no black-fill regression)", async () => {
    const source = await makeImage(800, 600, [10, 180, 60], true);
    const opts = optsFor("nearby_crop", 300, 300);
    const result = await finalize(source, opts);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(false);
  });

  it("edge_extend fills the full canvas (corner is not transparent/black void)", async () => {
    const source = await makeImage(800, 700, [40, 90, 200]);
    const opts = optsFor("edge_extend", 970, 300);
    const result = await finalize(source, opts);
    expect(result.width).toBe(970);
    expect(result.height).toBe(300);
    const corner = await cornerPixel(result.buffer);
    // blurred-background fill → some colour present, not a pure-black hole
    expect(corner.r + corner.g + corner.b).toBeGreaterThan(0);
  });
});

describe("image-finalizer / auto background follows source alpha", () => {
  function autoOpts(strategy: DeliveryStrategy, w: number, h: number): FinalizerOptions {
    return buildFinalizerOptions(
      {
        id: "auto",
        section: "custom",
        width: w,
        height: h,
        usage: "custom",
        backgroundIntent: "auto",
        contentIntent: "product",
        allowWhitePadding: true,
        allowSubjectCrop: false,
        minWorkingLongSide: 1024,
      },
      strategy,
    );
  }

  it("preserves transparency for a source WITH alpha (png + alpha out)", async () => {
    const source = await makeImage(400, 600, [200, 30, 30], true);
    const opts = autoOpts("white_pad", 300, 300);
    expect(opts.background.type).toBe("auto"); // deferred at plan time
    const result = await finalize(source, opts);
    expect(result.format).toBe("png");
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it("flattens an opaque source to white jpeg (no alpha out)", async () => {
    const source = await makeImage(400, 600, [200, 30, 30], false);
    const opts = autoOpts("white_pad", 300, 300);
    const result = await finalize(source, opts);
    expect(result.format).toBe("jpeg");
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(false);
  });
});

describe("image-finalizer / EXIF orientation", () => {
  it("respects orientation so a rotated source still hits exact target", async () => {
    // orientation 6 = rotate 90°; sharp().rotate() with no arg honors it
    const source = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const opts = optsFor("native", 300, 300);
    const result = await finalize(source, opts);
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });
});

describe("image-finalizer / registry smoke", () => {
  it("finalizes a source to every registry slot's exact size", async () => {
    const source = await makeImage(1024, 1024, [120, 120, 120]);
    for (const spec of TARGET_SIZE_REGISTRY) {
      const opts = buildFinalizerOptions(spec, spec.preferredStrategy ?? "native");
      const result = await finalize(source, opts);
      expect(result.width).toBe(spec.width);
      expect(result.height).toBe(spec.height);
    }
  });
});
