// src/image-generation/gateway-image.provider.spec.ts
//
// 轨道 B(B1)网关适配器单测:mock AiGatewayProvider(提交/轮询/终态),
// 覆盖尺寸意图/参考图/幂等键、实际尺寸与适配信息、计费与终态错误。

import { BadRequestException, HttpException, HttpStatus } from "@nestjs/common";
import { AiModelModality } from "@prisma/client";
import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk";
import sharp from "sharp";
import * as storage from "./core/storage";
import type { AiGatewayModelService } from "../ai-gateway/ai-gateway-model.service";
import { AiGatewayImageCallbacksService } from "../ai-gateway/ai-gateway-image-callbacks.service";
import type { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider";
import type { PrismaService } from "../prisma/prisma.service";
import { RelayError } from "./core/retry-utils";
import type { ProviderGenerateInput } from "./core/types";
import { IMAGE_GENERATION_MODEL_CATEGORY, ImageGenerationModelsService } from "./models.service";
import { createGatewayImageProvider } from "./providers/gateway-image.provider";

const originalFetch = global.fetch;

async function pngBytes(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } },
  })
    .png()
    .toBuffer();
}

beforeEach(() => {
  jest.spyOn(storage, "uploadRemoteUrlToSpaces").mockResolvedValue("https://stored.example/original.png");
  // 默认屏蔽真实网络:归一化产物下载失败 → 保原 URL(确定性路径),
  // 关心归一命中的用例各自覆写 fetch。
  global.fetch = jest
    .fn()
    .mockRejectedValue(new Error("no network in tests")) as unknown as typeof fetch;
  // backstop 轮询间隔 1ms:queued→terminal 用例快速走兜底路径
  process.env.IMAGE_GATEWAY_CALLBACK_BACKSTOP_MS = "1";
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE;
  delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE_SKIP;
  delete process.env.IMAGE_GATEWAY_CALLBACK_BACKSTOP_MS;
  delete process.env.IMAGE_GATEWAY_POLL_TIMEOUT_MS;
  delete process.env.IMAGE_GATEWAY_SIZE_DOWNGRADE;
});

function makeGateway(over: Partial<AiGatewayProvider> = {}) {
  return {
    fetchModelSnapshot: jest.fn().mockResolvedValue({
      detail: { modality: "image", facts: {} },
      requestSchema: { request_schema: { type: "object", properties: {} } },
    }),
    createImageTask: jest.fn(),
    getImageTask: jest.fn(),
    listImageModels: jest.fn(),
    ...over,
  } as unknown as AiGatewayProvider;
}

function baseInput(over: Partial<ProviderGenerateInput> = {}): ProviderGenerateInput {
  return {
    referenceImages: [],
    prompt: "一只马克杯",
    aspectRatio: "1:1",
    resolutionTier: "2K",
    resolution: "2048x2048",
    idempotencyKey: "imggen:job-1:42:1",
    ...over,
  };
}

const succeededTask = (over: Record<string, unknown> = {}): ImageTask =>
  ({
    id: "gw-task-1",
    status: "succeeded",
    result: { images: [{ url: "https://gw.example/artifact.png" }] },
    usage: { amount: "0.75", currency: "CNY" },
    ...over,
  }) as unknown as ImageTask;

it("交付恢复读取已成功网关任务，不重新提交收费生成", async () => {
  const onGenerated = jest.fn().mockResolvedValue(undefined)
  const gateway = makeGateway({ getImageTask: jest.fn().mockResolvedValue(succeededTask()) })
  const provider = createGatewayImageProvider(gateway, "ZQ-Image-2")
  await provider.generate(baseInput({ resumeTaskId: "gw-task-1", onGenerated }))
  expect(gateway.getImageTask).toHaveBeenCalledWith("gw-task-1")
  expect(gateway.createImageTask).not.toHaveBeenCalled()
  expect(onGenerated).toHaveBeenCalledWith("gw-task-1")
})

function nativeSnapshot() {
  return {
    detail: { modality: "image", facts: {} },
    requestSchema: {
      request_schema: {
        type: "object",
        properties: {
          aspect_ratio: { enum: ["2:3", "21:9"] },
          resolution: { enum: ["2k", "4k"] },
        },
      },
    },
  };
}

describe("网关原生尺寸直传", () => {

  it("独立留存网关原图，成品原生直出地址不变", async () => {
    const gateway = makeGateway({
      fetchModelSnapshot: jest.fn().mockResolvedValue(nativeSnapshot()),
      createImageTask: jest.fn().mockResolvedValue(succeededTask()),
    });
    const result = await createGatewayImageProvider(gateway, "ZQ-Image-2")
      .generate(baseInput({ aspectRatio: "2:3" }));
    expect(storage.uploadRemoteUrlToSpaces).toHaveBeenCalledWith(expect.objectContaining({ url: "https://gw.example/artifact.png" }));
    expect(result.url).toBe("https://gw.example/artifact.png");
    expect(result.gatewayImage?.originalUrl).toBe("https://stored.example/original.png");
    expect(gateway.createImageTask).toHaveBeenCalledTimes(1);
  });

  it("原图留存失败不影响成品成功、不重提模型", async () => {
    jest.mocked(storage.uploadRemoteUrlToSpaces).mockRejectedValue(new Error("storage unavailable"));
    const gateway = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) });
    const result = await createGatewayImageProvider(gateway, "ZQ-Image-2").generate(baseInput());
    expect(result.url).toBe("https://gw.example/artifact.png");
    expect(result.gatewayImage?.originalUrl).toBeUndefined();
    expect(result.costAmountCny).toBe("0.75");
    expect(gateway.createImageTask).toHaveBeenCalledTimes(1);
  });

  it("自定义比例原值命中能力时直传比例，忽略工作尺寸", async () => {
    const gateway = makeGateway({
      fetchModelSnapshot: jest.fn().mockResolvedValue(nativeSnapshot()),
      createImageTask: jest.fn().mockResolvedValue(succeededTask()),
    });
    await createGatewayImageProvider(gateway, "gpt-image-2.5-flare").generate(baseInput({
      aspectRatio: "custom", customAspectW: 2, customAspectH: 3, resolutionTier: "4K",
      workingWidth: 1024, workingHeight: 1024,
    }));
    const request = (gateway.createImageTask as jest.Mock).mock.calls[0][0];
    expect(request).toMatchObject({ aspect_ratio: "2:3", resolution: "4k" });
    expect(request).not.toHaveProperty("size");
  });

  it("能力查询失败时不提交图片任务", async () => {
    const gateway = makeGateway({
      fetchModelSnapshot: jest.fn().mockRejectedValue(new HttpException("unavailable", HttpStatus.SERVICE_UNAVAILABLE)),
    });
    await expect(createGatewayImageProvider(gateway, "ZQ-Image-2").generate(baseInput()))
      .rejects.toMatchObject({ kind: "transient_server" });
    expect(gateway.createImageTask).not.toHaveBeenCalled();
  });

  it.each(["submit", "terminal"])("原生请求在 %s 阶段因尺寸失败时不降档重提", async stage => {
    const createImageTask = stage === "submit"
      ? jest.fn().mockRejectedValue(new BadRequestException("size exceeds the maximum edge 3840"))
      : jest.fn().mockResolvedValue({ id: "gw-failed", status: "failed", error: {
        type: "invalid_request_error", message: "size exceeds the maximum edge 3840",
      } });
    const gateway = makeGateway({ fetchModelSnapshot: jest.fn().mockResolvedValue(nativeSnapshot()), createImageTask });
    await expect(createGatewayImageProvider(gateway, "gpt-image-2.5-flare").generate(
      baseInput({ aspectRatio: "2:3", resolutionTier: "4K" }),
    )).rejects.toMatchObject({ kind: "permanent_validation" });
    expect(createImageTask).toHaveBeenCalledTimes(1);
    expect(createImageTask.mock.calls[0][0].resolution).toBe("4k");
  });

});

describe("gateway-image provider (B1)", () => {
  it.each([
    "ZQ-Image-1", "ZQ-Image-1-Backup", "ZQ-Image-2", "ZQ-Image-2-Backup",
    "ZQ-Image-3", "ZQ-Image-3-Backup", "ZQ-Image-Ultra", "ZQ-Image-Ultra-Backup",
    "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
  ])("%s 特殊比例使用同一文案且保留原始交付目标", async model => {
    const gateway = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) });
    await createGatewayImageProvider(gateway, model).generate(baseInput({
      aspectRatio: "custom", customAspectW: 10, customAspectH: 3,
      referenceImages: [{ url: "https://cdn.example/ref.png", mimeType: "image/png", base64: "AA==" }],
    }));
    const request = (gateway.createImageTask as jest.Mock).mock.calls[0][0];
    expect(request.prompt).toContain("最终交付目标为宽高比 10:3");
    expect(request.prompt.match(/中心裁剪安全构图：/g)).toHaveLength(1);
    expect(request.operation).toBe("edit");
    expect(request.reference_images).toEqual([{ url: "https://cdn.example/ref.png" }]);
  });

  it.each([undefined, "", "   "])(
    "rejects a reference without a usable URL (%s) before submitting",
    async (url) => {
      const gateway = makeGateway({
        createImageTask: jest.fn().mockResolvedValue(succeededTask()),
      });
      const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
      await expect(
        provider.generate(
          baseInput({
            referenceImages: [{ mimeType: "image/png", base64: "AA==", url }],
          }),
        ),
      ).rejects.toMatchObject({
        kind: "permanent_validation",
        message: "参考图片缺少可用地址，请重新上传后重试",
      });
      expect(gateway.createImageTask).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed references instead of silently dropping one", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue(succeededTask()),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
    await expect(
      provider.generate(
        baseInput({
          referenceImages: [
            { mimeType: "image/png", base64: "AA==", url: "https://cdn.example/ref.png" },
            { mimeType: "image/png", base64: "AA==" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ kind: "permanent_validation" });
    expect(gateway.createImageTask).not.toHaveBeenCalled();
  });

  it("submits with translated request + idempotency key, polls to success, returns artifact and amount", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-task-1", status: "queued" }),
      getImageTask: jest.fn().mockResolvedValue(succeededTask()),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
    const result = await provider.generate(
      baseInput({
        referenceImages: [
          { mimeType: "image/png", base64: "AA==", url: "https://cdn.example/ref.png" },
        ],
      }),
    );

    const [params, idem] = (gateway.createImageTask as jest.Mock).mock.calls[0];
    expect(idem).toBe("imggen:job-1:42:1");
    expect(params.model).toBe("ZQ-Image-2");
    expect(params.prompt).toBe("一只马克杯");
    expect(params.operation).toBe("edit"); // 有参考图 → edit
    expect(params.n).toBe(1);
    expect(params.reference_images).toEqual([{ url: "https://cdn.example/ref.png" }]);
    expect(params.aspect_ratio).toBe("1:1");
    expect(params.resolution).toBe("2k"); // 档位意图(0.13.0 intent sizing)
    expect(params.callback).toBe(true); // 终态走 webhook 回调,轮询只兜底

    expect(result.url).toBe("https://gw.example/artifact.png");
    expect(result.costAmountCny).toBe("0.75");
    expect(result.gatewayTaskId).toBe("gw-task-1");
    expect(result.tokenUsage).toBeUndefined();
  });

  it.each([
    {
      customAspectW: 1254,
      customAspectH: 1254,
      customSizeMode: "pixels" as const,
      size: "1254x1254",
    },
    {
      customAspectW: 900,
      customAspectH: 1400,
      customSizeMode: "pixels" as const,
      size: "900x1400",
    },
  ])("converts legacy pixels $size to ratio intent", async ({ size, ...custom }) => {
    const gateway = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) });
    await createGatewayImageProvider(gateway, "ZQ-Image-2").generate(
      baseInput({
        ...custom,
        aspectRatio: "custom",
        resolutionTier: "1K",
        resolution: "1254x1254",
        referenceImages: [
          { mimeType: "image/png", base64: "AA==", url: "https://cdn.example/ref.png" },
        ],
      }),
    );
    const request = (gateway.createImageTask as jest.Mock).mock.calls[0][0];
    expect(request).toMatchObject({
      aspect_ratio: size.replace("x", ":"),
      resolution: "1k",
      operation: "edit",
      reference_images: [{ url: "https://cdn.example/ref.png" }],
    });
    expect(request).not.toHaveProperty("size");
  });

  describe.each(["ZQ-Image-Ultra", "ZQ-Image-Ultra-Backup"])("%s 原始尺寸意图", (model) => {
    it.each([
      ["1K", "1k", false],
      ["2K", "2k", false],
      ["1K", "1k", true],
      ["2K", "2k", true],
    ] as const)("4:5 × %s → %s, reference=%s", async (resolutionTier, resolution, withRef) => {
      const gateway = makeGateway({
        createImageTask: jest.fn().mockResolvedValue(succeededTask()),
      });
      await createGatewayImageProvider(gateway, model).generate(
        baseInput({
          aspectRatio: "4:5",
          resolutionTier,
          prompt: "小女孩，819×1024",
          referenceImages: withRef
            ? [{ url: "https://cdn.example/ref.png", mimeType: "image/png", base64: "AA==" }]
            : [],
        }),
      );
      const request = (gateway.createImageTask as jest.Mock).mock.calls[0][0];
      expect(request).toMatchObject({
        model,
        aspect_ratio: "4:5",
        resolution,
        operation: withRef ? "edit" : "generate",
      });
      expect(request).not.toHaveProperty("size");
      expect(request.reference_images).toEqual(
        withRef ? [{ url: "https://cdn.example/ref.png" }] : undefined,
      );
    });
  });

  it("does not replace ratio intent with internal working dimensions", async () => {
    const gateway = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) });
    await createGatewayImageProvider(gateway, "ZQ-Image-Ultra").generate(
      baseInput({
        aspectRatio: "4:5",
        resolutionTier: "1K",
        workingWidth: 1024,
        workingHeight: 1536,
      }),
    );
    const request = (gateway.createImageTask as jest.Mock).mock.calls[0][0];
    expect(request).toMatchObject({ aspect_ratio: "4:5", resolution: "1k" });
    expect(request).not.toHaveProperty("size");
  });

  it("maps legacy 3K snapshots down to 2k resolution (3K 已下线, 2026-09-14)", async () => {
    const gateway = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) });
    await createGatewayImageProvider(gateway, "ZQ-Image-1").generate(
      baseInput({ aspectRatio: "16:9", resolutionTier: "3K" }),
    );
    expect((gateway.createImageTask as jest.Mock).mock.calls[0][0]).toMatchObject({
      aspect_ratio: "16:9",
      resolution: "2k",
    });
  });

  it("returns actual dimensions and adaptation without cropping away the gateway result", async () => {
    // 回显 1728×2304(3:4@2k)与请求 4:5@1K(目标 819×1024)不符;此处产物
    // 字节喂 819×1024(命中快路径),断言回显透传且 URL 不动。
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => await pngBytes(819, 1024),
    }) as unknown as typeof fetch;
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue(
        succeededTask({
          adaptation: {
            requested: { aspect_ratio: "4:5", resolution: "1k" },
            actual: { size: "1728x2304", aspect_ratio: "3:4", resolution: "2k" },
            changes: ["比例调整", "档位调整"],
          },
        }),
      ),
    });
    const result = await createGatewayImageProvider(gateway, "ZQ-Image-Ultra").generate(
      baseInput({ aspectRatio: "4:5", resolutionTier: "1K" }),
    );
    expect(result).toMatchObject({
      url: "https://gw.example/artifact.png",
      gatewayImage: {
        width: 1728,
        height: 2304,
        adaptation: {
          requested: { aspect_ratio: "4:5", resolution: "1k" },
          actual: { size: "1728x2304", aspect_ratio: "3:4", resolution: "2k" },
          changes: ["比例调整", "档位调整"],
        },
      },
    });
    expect(result.gatewayImage?.normalized).toBeUndefined();
  });

  it("classifies failed terminal tasks (invalid_request_error → permanent_validation)", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({
        id: "gw-task-2",
        status: "queued",
      }),
      getImageTask: jest.fn().mockResolvedValue({
        id: "gw-task-2",
        status: "failed",
        error: { type: "invalid_request_error", code: "bad_prompt", message: "x" },
      }),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
    await expect(provider.generate(baseInput())).rejects.toMatchObject({
      kind: "permanent_validation",
    });
  });

  it("maps expired tasks to transient_timeout and honors the wait deadline", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-3", status: "queued" }),
      getImageTask: jest.fn().mockResolvedValue({ id: "gw-3", status: "expired" }),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
    await expect(provider.generate(baseInput())).rejects.toBeInstanceOf(RelayError);

    // 一直 queued → 等待截止(transient_timeout);backstop 终检仍未终态。
    const gateway2 = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-4", status: "queued" }),
      getImageTask: jest.fn().mockResolvedValue({ id: "gw-4", status: "queued" }),
    });
    process.env.IMAGE_GATEWAY_POLL_TIMEOUT_MS = "1";
    try {
      const provider2 = createGatewayImageProvider(gateway2, "ZQ-Image-2");
      await expect(provider2.generate(baseInput())).rejects.toMatchObject({
        kind: "transient_timeout",
      });
    } finally {
      delete process.env.IMAGE_GATEWAY_POLL_TIMEOUT_MS;
    }
  });

  it("直递模式:hub waiter 命中终态回调,全程不触发查询(backstop 不 firing)", async () => {
    const hub = new AiGatewayImageCallbacksService();
    const getImageTask = jest.fn();
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-cb-1", status: "queued" }),
      getImageTask,
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2", hub);
    const pending = provider.generate(baseInput());
    // 等待 provider 注册 waiter 后模拟 webhook 分发终态
    await new Promise((r) => setTimeout(r, 10));
    hub.notify(succeededTask({ id: "gw-cb-1" }) as unknown as ImageTask);
    const result = await pending;
    expect(result.gatewayTaskId).toBe("gw-cb-1");
    expect(result.costAmountCny).toBe("0.75");
    expect(getImageTask).not.toHaveBeenCalled();
  });

  it("快任务竞态:终态回调先到(hub 近期缓存),waitForTerminal 立即取走", async () => {
    const hub = new AiGatewayImageCallbacksService();
    const getImageTask = jest.fn();
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-cb-2", status: "queued" }),
      getImageTask,
    });
    // 回调在 createImageTask 响应/等待注册之前已到 —— hub 缓存
    hub.notify(succeededTask({ id: "gw-cb-2" }) as unknown as ImageTask);
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2", hub);
    const result = await provider.generate(baseInput());
    expect(result.gatewayTaskId).toBe("gw-cb-2");
    expect(getImageTask).not.toHaveBeenCalled();
  });

  it("translates submission auth failures into permanent_auth RelayError", async () => {
    const gateway = makeGateway({
      createImageTask: jest
        .fn()
        .mockRejectedValue(new HttpException("unauthorized", HttpStatus.UNAUTHORIZED)),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
    await expect(provider.generate(baseInput())).rejects.toMatchObject({
      kind: "permanent_auth",
    });
  });

  it.each([
    "No upstream route can serve this request: aspect_ratio '4:5' is not supported",
    "No priced image task route is available",
  ])("does not change sizing or resubmit on route rejection: %s", async (message) => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockRejectedValue(new BadRequestException(message)),
    });
    await expect(
      createGatewayImageProvider(gateway, "ZQ-Image-Ultra").generate(
        baseInput({ aspectRatio: "4:5" }),
      ),
    ).rejects.toMatchObject({ kind: "permanent_validation" });
    expect(gateway.createImageTask).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit an asynchronously failed route with different sizing", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-a", status: "queued" }),
      getImageTask: jest
        .fn()
        .mockResolvedValue({
          id: "gw-a",
          status: "failed",
          error: { type: "server_error", message: "No priced image task route is available" },
        }),
    });
    await expect(
      createGatewayImageProvider(gateway, "ZQ-Image-Ultra").generate(baseInput()),
    ).rejects.toMatchObject({ kind: "permanent_validation" });
    expect(gateway.createImageTask).toHaveBeenCalledTimes(1);
  });

  it("keeps non-aspect async failures classified by error type (server_error → transient_server)", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-c", status: "queued" }),
      getImageTask: jest.fn().mockResolvedValue({
        id: "gw-c",
        status: "failed",
        error: { type: "server_error", code: "upstream_crash", message: "boom" },
      }),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-2");
    await expect(provider.generate(baseInput())).rejects.toMatchObject({
      kind: "transient_server",
    });
    // 非 aspect 失败不做 size 回退
    expect((gateway.createImageTask as jest.Mock).mock.calls).toHaveLength(1);
  }, 20_000);

  it("keeps polling through transient fetch errors until terminal", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue({ id: "gw-5", status: "queued" }),
      getImageTask: jest
        .fn()
        .mockRejectedValueOnce(new BadRequestException("blip")) // 瞬态,继续轮询
        .mockResolvedValue(succeededTask({ id: "gw-5" })),
    });
    const provider = createGatewayImageProvider(gateway, "ZQ-Image-1");
    const result = await provider.generate(baseInput());
    expect(result.url).toBe("https://gw.example/artifact.png");
  }, 20_000);

  describe("产物尺寸归一化 (T3 接线)", () => {

    it("产物与目标一致(快路径)→ 保原 URL,无 normalized 字段", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => await pngBytes(2048, 1152),
      }) as unknown as typeof fetch;
      const gateway = makeGateway({
        createImageTask: jest.fn().mockResolvedValue(succeededTask()),
      });
      const result = await createGatewayImageProvider(gateway, "ZQ-Image-2").generate(
        baseInput({ aspectRatio: "16:9" }),
      );
      expect(result.url).toBe("https://gw.example/artifact.png");
      expect(result.gatewayImage?.normalized).toBeUndefined();
    });

    it("下载失败 → 保原 URL(已成功的图不能丢)", async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
      const gateway = makeGateway({
        createImageTask: jest.fn().mockResolvedValue(succeededTask()),
      });
      const result = await createGatewayImageProvider(gateway, "ZQ-Image-2").generate(
        baseInput({ aspectRatio: "16:9" }),
      );
      expect(result.url).toBe("https://gw.example/artifact.png");
      expect(result.gatewayImage?.normalized).toBeUndefined();
    });

    it("pixels 模式的归一目标 = 表单精确像素(不动档位)", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => await pngBytes(1254, 1254),
      }) as unknown as typeof fetch;
      const gateway = makeGateway({
        createImageTask: jest.fn().mockResolvedValue(succeededTask()),
      });
      const result = await createGatewayImageProvider(gateway, "ZQ-Image-2").generate(
        baseInput({
          aspectRatio: "custom",
          customAspectW: 1254,
          customAspectH: 1254,
          customSizeMode: "pixels",
          resolutionTier: "1K",
        }),
      );
      // 目标即 1254² → 快路径跳过,保原 URL
      expect(result.url).toBe("https://gw.example/artifact.png");
      expect(result.gatewayImage?.normalized).toBeUndefined();
    });
  });
});

describe("image-generation models service (D6 aggregate)", () => {
  it("serves onboarded models from the AiGatewayModel catalog and triggers the read-time refresh", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { publicId: "ZQ-Image-1", displayName: "ZQ-Image-1（Nano Banana 2）", fixedCredits: null },
      {
        publicId: "ZQ-Image-Ultra",
        displayName: "ZQ-Image-Ultra（超清）",
        fixedCredits: { toString: () => "15" },
      },
    ]);
    const prisma = { aiGatewayModel: { findMany } } as unknown as PrismaService;
    const maybeRefreshModels = jest.fn().mockResolvedValue(undefined);
    const catalog = { maybeRefreshModels } as unknown as AiGatewayModelService;
    const service = new ImageGenerationModelsService(prisma, catalog);
    const list = await service.list();
    expect(list).toEqual([
      {
        id: "ZQ-Image-1",
        label: "ZQ-Image-1（Nano Banana 2）",
        backend: "gateway",
        fixedCredits: null,
      },
      {
        id: "ZQ-Image-Ultra",
        label: "ZQ-Image-Ultra（超清）",
        backend: "gateway",
        fixedCredits: "15",
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        modality: AiModelModality.IMAGE,
        category: IMAGE_GENERATION_MODEL_CATEGORY,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { publicId: true, displayName: true, fixedCredits: true },
    });
    expect(maybeRefreshModels).toHaveBeenCalledWith(
      AiModelModality.IMAGE,
      IMAGE_GENERATION_MODEL_CATEGORY,
    );
  });

  it("serves an empty list when no models are onboarded (frontend falls back to static)", async () => {
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const catalog = {
      maybeRefreshModels: jest.fn().mockResolvedValue(undefined),
    } as unknown as AiGatewayModelService;
    const service = new ImageGenerationModelsService(prisma, catalog);
    await expect(service.list()).resolves.toEqual([]);
  });
});

describe("尺寸能力降档（2026-09-22，UAT 2:3@4K 秒失败落地）", () => {

  it("预检降档：未登记模型零行为变化（4k intent 原样提交，无 sizingAdjusted）", async () => {
    const gateway = makeGateway({
      createImageTask: jest.fn().mockResolvedValue(succeededTask()),
    });
    const result = await createGatewayImageProvider(gateway, "ZQ-Image-9").generate(
      baseInput({ aspectRatio: "2:3", resolutionTier: "4K" }),
    );
    expect((gateway.createImageTask as jest.Mock).mock.calls[0][0]).toMatchObject({
      aspect_ratio: "2:3",
      resolution: "4k",
    });
    expect(result.gatewayImage?.sizingAdjusted).toBeUndefined();
  });

  it("总开关 off → 失败不重提（一键回退 2026-09-22 前行为）", async () => {
    process.env.IMAGE_GATEWAY_SIZE_DOWNGRADE = "off";
    const createImageTask = jest
      .fn()
      .mockRejectedValue(
        new BadRequestException("size '2731x4096' exceeds the maximum allowed pixels 8294400"),
      );
    const gateway = makeGateway({ createImageTask });
    await expect(
      createGatewayImageProvider(gateway, "ZQ-Image-9").generate(
        baseInput({ aspectRatio: "2:3", resolutionTier: "4K" }),
      ),
    ).rejects.toMatchObject({ kind: "permanent_validation", message: "该模型不支持此比例/清晰度" });
    expect(createImageTask).toHaveBeenCalledTimes(1);
  });

  it("非尺寸类永久失败不触发降档重提（既有口径）", async () => {
    const createImageTask = jest
      .fn()
      .mockRejectedValue(new BadRequestException("prompt contains banned words"));
    const gateway = makeGateway({ createImageTask });
    await expect(
      createGatewayImageProvider(gateway, "ZQ-Image-9").generate(baseInput()),
    ).rejects.toMatchObject({ kind: "permanent_validation" });
    expect(createImageTask).toHaveBeenCalledTimes(1);
  });
});

describe("所有网关生图共用尺寸意图和交付规则", () => {
  it.each([
    ["16:9", undefined, undefined, undefined, "16:9"],
    ["64:51", undefined, undefined, undefined, "64:51"],
    ["2048:614", undefined, undefined, undefined, "2048:614"],
    ["2:1", undefined, undefined, undefined, "2:1"],
    ["custom", "ratio", 10, 3, "10:3"],
    ["custom", "ratio", 2048, 614, "2048:614"],
    ["custom", "pixels", 2048, 614, "2048:614"],
    ["custom", "pixels", 970, 300, "970:300"],
  ])("%s / %s 统一发送比例档位", async (aspectRatio, customSizeMode, customAspectW, customAspectH, expected) => {
    const gw = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) })
    await createGatewayImageProvider(gw, "gpt-image-2.5-flare").generate(baseInput({
      aspectRatio: aspectRatio as any, customSizeMode: customSizeMode as any, customAspectW, customAspectH, resolutionTier: "4K",
    }))
    const request = (gw.createImageTask as jest.Mock).mock.calls[0][0]
    expect(request).toMatchObject({ aspect_ratio: expected, resolution: "4k", strict: false })
    expect(request).not.toHaveProperty("size")
  })
  it.each([[160, 90, false], [160, 120, true]])("实际 %s×%s 按比例检查后交付", async (width, height, crop) => {
    const bytes = await pngBytes(width as number, height as number)
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer })
    const gw = makeGateway({ createImageTask: jest.fn().mockResolvedValue(succeededTask()) })
    const result = await createGatewayImageProvider(gw, "ZQ-Image-2").generate(baseInput({ aspectRatio: "16:9" }))
    expect(result.gatewayImage).toMatchObject({ ratioDelivery: true, originalUrl: "https://stored.example/original.png" })
    if (crop) {
      expect(result.gatewayImage?.normalized).toMatchObject({ from: "160x120", to: "160x90", ops: ["crop:centre", "reencode:jpeg"] })
      expect(result.url).toMatch(/^data:image\/jpeg/)
    } else {
      expect(result.gatewayImage?.normalized).toBeUndefined()
      expect(result.url).toBe("https://gw.example/artifact.png")
    }
    expect(storage.uploadRemoteUrlToSpaces).toHaveBeenCalledTimes(1)
    expect(gw.createImageTask).toHaveBeenCalledTimes(1)
  })
  it("尺寸失败不再降档另建收费任务", async () => {
    const gw = makeGateway({ createImageTask: jest.fn().mockRejectedValue(new BadRequestException("size exceeds maximum pixels")) })
    await expect(createGatewayImageProvider(gw, "ZQ-Image-2").generate(baseInput({ resolutionTier: "4K" }))).rejects.toThrow()
    expect(gw.createImageTask).toHaveBeenCalledTimes(1)
  })
  it("不支持的编辑操作仍在提交前拒绝", async () => {
    const snapshot = nativeSnapshot()
    Object.assign(snapshot.requestSchema.request_schema.properties, { operation: { const: "generate" } })
    const gw = makeGateway({ fetchModelSnapshot: jest.fn().mockResolvedValue(snapshot) })
    await expect(createGatewayImageProvider(gw, "ZQ-Image-2").generate(baseInput({ referenceImages: [{ url: "https://example.com/a.png" }] as any }))).rejects.toThrow()
    expect(gw.createImageTask).not.toHaveBeenCalled()
  })
})

// 本文件只验证业务执行；真实文件标识由aigc/image-label.spec.ts覆盖。
jest.mock("../aigc/image-label", () => ({ labelImage: jest.fn((buffer: Buffer) => Promise.resolve({ buffer, mime: "image/png" })) }))
