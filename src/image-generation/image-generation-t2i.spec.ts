import { withDeliveryCheckpoint } from "../aigc/test-prisma"
// src/image-generation/image-generation-t2i.spec.ts
//
// t2i 链路单测(mock Prisma + mock Provider + 假 Spaces transport):
//   - 创建校验/默认值/负向 prompt 折叠(契约对齐 Next 路由)
//   - 快照投影 pending/done/error 与过期 404 语义
//   - 执行器:CAS 认领、成功结算、失败文案、Job 聚合、晚到结果不覆盖

import { Test } from "@nestjs/testing";
import { Decimal } from "@prisma/client/runtime/library";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { UsageService } from "../usage/usage.service";
import { resetSpacesPresignTransport, setSpacesPresignTransport } from "./core/storage";
import { RelayError } from "./core/retry-utils";
import type { ImageProvider } from "./core/types";
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import {
  ImageGenItemRunnerService,
  type ImageGenRequestSnapshot,
} from "./executor/image-gen-item-runner.service";
import { IMAGE_PROVIDER_FACTORY } from "./providers/provider-factory.token";
import { TextToImageService } from "./text-to-image.service";

const mockPrisma = () => ({
  imageGenJob: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  imageGenItem: {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
});

const fakePresign = {
  uploadUrl: "https://presigned.example/put",
  publicUrl: "https://cdn.example/hosted.png",
  headers: { "x-amz-acl": "public-read" },
};

async function makeServices(overrides?: {
  prisma?: ReturnType<typeof mockPrisma>;
  provider?: Partial<ImageProvider>;
}) {
  const prisma = overrides?.prisma ?? mockPrisma();
  const usage = {
    chargeTokens: jest.fn().mockResolvedValue(undefined),
    chargeModel: jest.fn().mockResolvedValue(undefined),
    gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(1)),
  };
  const provider: ImageProvider = {
    id: "test",
    ...(overrides?.provider ?? {}),
  } as ImageProvider;
  const moduleRef = await Test.createTestingModule({
    providers: [
      TextToImageService,
      ImageGenItemRunnerService,
      { provide: DispatchQueueService, useValue: { enqueue: jest.fn() } },
      { provide: PrismaService, useValue: withDeliveryCheckpoint(prisma) },
      { provide: IMAGE_PROVIDER_FACTORY, useValue: () => provider },
      { provide: UsageService, useValue: usage },
    ],
  }).compile();
  return {
    prisma,
    usage,
    queue: moduleRef.get(DispatchQueueService) as unknown as {
      enqueue: jest.Mock;
    },
    t2i: moduleRef.get(TextToImageService),
    runner: moduleRef.get(ImageGenItemRunnerService),
  };
}

describe("text-to-image create (contract parity)", () => {
  it("rejects retired provider slots with Next-identical message (B4)", async () => {
    const { t2i } = await makeServices();
    const r = await t2i.create({ provider: "atlas-wan", prompt: "x" }, 1);
    expect(r).toEqual({ ok: false, status: 400, error: "Unsupported provider: atlas-wan" });
  });

  it("allows dynamic gateway model ids (D6; B4 后目录直传一律网关)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findFirst.mockResolvedValue({ id: 42 });
    const { t2i } = await makeServices({ prisma });
    const r = await t2i.create({ provider: "ZQ-Image-New-Model", prompt: "x" }, 7);
    expect(r.ok).toBe(true);
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    expect(created.request.provider).toBe("ZQ-Image-New-Model");
  });

  it.each(["64:51", "2048:614", "2:1"])("文生图原样保存自定义比例 %s，不回退 16:9", async aspectRatio => {
    const prisma = mockPrisma()
    prisma.imageGenItem.findFirst.mockResolvedValue({ id: 42 })
    const { t2i } = await makeServices({ prisma })
    const result = await t2i.create({
      provider: "ZQ-Image-2", prompt: "调整商品背景", aspectRatio, resolutionTier: "4K",
    }, 7)
    expect(result.ok).toBe(true)
    expect(prisma.imageGenJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        request: expect.objectContaining({ aspectRatio, resolutionTier: "4K" }),
      }),
    }))
  })

  it("rejects missing prompt", async () => {
    const { t2i } = await makeServices();
    const r = await t2i.create({ provider: "atlas-gpt", prompt: "  " }, 1);
    expect(r).toEqual({ ok: false, status: 400, error: "`prompt` is required" });
  });

  it("folds negativePrompt, applies defaults, persists job and dispatches item", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findFirst.mockResolvedValue({ id: 42 });
    const { t2i, queue } = await makeServices({ prisma });
    const r = await t2i.create(
      {
        provider: "atlas-gpt",
        prompt: "角色卡",
        negativePrompt: "不要文字",
        aspectRatio: "bogus",
        resolutionTier: "bogus",
      },
      7,
    );
    expect(r.ok).toBe(true);
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    expect(created.userId).toBe(7);
    expect(created.kind).toBe("TEXT_TO_IMAGE");
    expect((created.request as ImageGenRequestSnapshot).prompt).toBe(
      "角色卡\n\nNegative prompt: 不要文字",
    );
    expect((created.request as ImageGenRequestSnapshot).aspectRatio).toBe("16:9");
    expect((created.request as ImageGenRequestSnapshot).resolutionTier).toBe("2K");
    expect(created.items.create).toEqual([{ idx: 0, status: "QUEUED" }]);
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it("remaps retired 3K tier down to 2K (网关 2026-09-14 下线 3k 档)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findFirst.mockResolvedValue({ id: 42 });
    const { t2i } = await makeServices({ prisma });
    const r = await t2i.create(
      { provider: "atlas-gpt", prompt: "角色卡", resolutionTier: "3K" },
      7,
    );
    expect(r.ok).toBe(true);
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    expect((created.request as ImageGenRequestSnapshot).resolutionTier).toBe("2K");
  });
});

describe("text-to-image snapshot projection", () => {
  it("projects pending while item is QUEUED/RUNNING", async () => {
    for (const status of ["QUEUED", "RUNNING"]) {
      const prisma = mockPrisma();
      prisma.imageGenJob.findUnique.mockResolvedValue({
        id: "j1",
        expiresAt: new Date(Date.now() + 60_000),
        items: [{ status, url: null, errorMessage: null, usage: null }],
      });
      const { t2i } = await makeServices({ prisma });
      expect(await t2i.getSnapshot("j1")).toMatchObject({ status: "pending" });
    }
  });

  it("projects done/error and returns null when missing or expired", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findUnique
      .mockResolvedValueOnce({
        id: "j1",
        expiresAt: new Date(Date.now() + 60_000),
        items: [
          {
            status: "SUCCEEDED",
            url: "https://cdn.example/a.png",
            errorMessage: null,
            usage: { promptTokens: 1 },
            gatewayImage: {
              originalUrl: "https://stored.example/original.png",
              width: 1728,
              height: 2304,
              adaptation: {
                actual: { resolution: "2k", aspect_ratio: "3:4", size: "1728x2304" },
                changes: ["档位调整"],
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "j2",
        expiresAt: new Date(Date.now() + 60_000),
        items: [{ status: "FAILED", url: null, errorMessage: "上游错误", usage: null }],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "j3",
        expiresAt: new Date(Date.now() - 1),
        items: [],
      });
    const { t2i } = await makeServices({ prisma });
    expect(await t2i.getSnapshot("j1")).toMatchObject({
      status: "done",
      url: "https://cdn.example/a.png",
      originalUrl: "https://stored.example/original.png",
      usage: { promptTokens: 1 },
      gatewayImage: {
        width: 1728,
        height: 2304,
        adaptation: {
          actual: { resolution: "2k", aspect_ratio: "3:4", size: "1728x2304" },
          changes: ["档位调整"],
        },
      },
      serverBilled: true,
    });
    expect(await t2i.getSnapshot("j2")).toEqual({ status: "error", error: "上游错误" });
    expect(await t2i.getSnapshot("gone")).toBeNull();
    expect(await t2i.getSnapshot("j3")).toBeNull();
  });
});

describe("image-gen item runner", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: "job-1",
    userId: 7,
    kind: "TEXT_TO_IMAGE",
    businessType: "IMAGE_CREATIVE",
    status: "RUNNING",
    createdAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
    request: {
      kind: "TEXT_TO_IMAGE",
      provider: "atlas-gpt",
      prompt: "p",
      aspectRatio: "16:9",
      resolutionTier: "2K",
    },
    ...over,
  });

  beforeAll(() => {
    setSpacesPresignTransport({
      generateUploadUrl: async () => fakePresign,
    });
    (globalThis as Record<string, unknown>).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "" });
  });
  afterAll(() => {
    resetSpacesPresignTransport();
  });

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(""), headers: { get: () => "image/png" }, arrayBuffer: () => Promise.resolve(Buffer.from("fixture")) });
  });

  it("skips silently when CAS claim loses", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const { runner } = await makeServices({ prisma });
    await runner.executeItem(1);
    expect(prisma.imageGenItem.findUnique).not.toHaveBeenCalled();
  });

  it("claims, hosts output, settles with CAS and aggregates job", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // settle
    prisma.imageGenItem.findUnique.mockResolvedValue({ id: 1, job: job() });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([
      { status: "SUCCEEDED", usage: { promptTokens: 3, completionTokens: 4 } },
    ]); // aggregate view
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      tokenUsage: { promptTokens: 3, completionTokens: 4 },
      gatewayTaskId: "gw-job1-item1",
      gatewayImage: { width: 819, height: 1024, originalUrl: "https://stored.example/original.png" },
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "p", aspectRatio: "16:9", resolutionTier: "2K" }),
    );
    const settle = prisma.imageGenItem.updateMany.mock.calls[1][0];
    expect(settle.where).toEqual({ id: 1, status: "RUNNING" });
    expect(settle.data.status).toBe("SUCCEEDED");
    expect(settle.data.url).toBe(fakePresign.publicUrl);
    // 审计:gatewayImage 注入网关任务 id(2026-09-10 补齐)
    expect(settle.data.gatewayImage).toEqual({
      originalUrl: "https://stored.example/original.png",
      width: 819,
      height: 1024,
      gatewayTaskId: "gw-job1-item1",
    });
    expect(prisma.imageGenJob.updateMany.mock.calls[0][0].data).toEqual({
      status: "COMPLETED",
      tokenUsage: { promptTokens: 3, completionTokens: 4 },
    });
    // 计费统一:成功图由服务端扣费,source 与 generate 执行器一致。
    expect(usage.chargeTokens).toHaveBeenCalledWith(
      7,
      {
        promptTokens: 3,
        completionTokens: 4,
        thinkingTokens: undefined,
        source: "aicreative.image_generate",
        meta: {
          jobId: "job-1",
          kind: "TEXT_TO_IMAGE",
          provider: "atlas-gpt",
          imageCount: 1,
          gatewayTaskId: "gw-job1-item1",
        },
      },
      { invokeType: "PLATFORM" }
    )
  });

  it.each(["TEXT_TO_IMAGE", "IMAGE_TO_IMAGE"])("网关缺尺寸时从最终文件实测宽高保存：%s", async kind => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany.mockResolvedValue({ count: 1 });
    prisma.imageGenItem.findUnique.mockResolvedValue({ id: 1, idx: 0, job: job({
      kind, request: { ...job().request, kind, mode: "normal", resolution: "1024x1024" },
    }) });
    prisma.imageGenItem.findMany.mockResolvedValue([{ status: "SUCCEEDED" }]);
    const bytes = await sharp({ create: { width: 357, height: 211, channels: 3, background: "white" } }).png().toBuffer();
    const measured = { ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => bytes } as unknown as Response;
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(measured).mockResolvedValueOnce(measured).mockResolvedValueOnce(measured);
    const url = "https://outputs.nyc3.digitaloceanspaces.com/final.png";
    const generate = jest.fn().mockResolvedValue({ url, gatewayTaskId: "gw-no-size" });
    const { runner } = await makeServices({ prisma, provider: { generate } });

    await runner.executeItem(1);

    expect(prisma.imageGenItem.updateMany.mock.calls[1][0].data).toMatchObject({
      status: "SUCCEEDED", url: fakePresign.publicUrl, width: 357, height: 211,
      gatewayImage: { gatewayTaskId: "gw-no-size" },
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it("charges gateway amounts via chargeModel v2 (registry source + model + idempotent requestId, DB priceMultiplier)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.imageGenItem.findUnique.mockResolvedValue({ id: 1, job: job() });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "SUCCEEDED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      // Spaces URL 免 re-host(mock fetch 无 headers,远端转存路径在单测不可达)
      url: "https://bucket.nyc3.digitaloceanspaces.com/out/gw.png",
      costAmountCny: "0.75",
      gatewayTaskId: "gw-1",
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);
    // 倍率与其他模块同口径:逻辑 ID atlas-gpt 先解析到网关 model 再查
    // AiGatewayModel.priceMultiplier(目录缺行按 1)
    expect(usage.gatewayPriceMultiplier).toHaveBeenCalledWith("ZQ-Image-2-Backup");
    expect(usage.chargeModel).toHaveBeenCalledWith(7, "0.75", {
      source: "aicreative.image_generate",
      invokeType: "PLATFORM",
      model: "atlas-gpt",
      meta: {
        jobId: "job-1",
        kind: "TEXT_TO_IMAGE",
        gatewayTaskId: "gw-1",
        imageCount: 1,
        // 对账快照(与老 webhook 路径同口径)
        gatewayAmountCny: "0.75",
        priceMultiplier: "1",
      },
      requestId: "charge:imggen:job-1:1:0",
      allowOverdraft: true,
      creditMultiplier: new Decimal(1),
    });
    expect(usage.chargeTokens).not.toHaveBeenCalled();
  });

  it("does not charge when the settle CAS loses (late success after cancel/timeout)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 0 }); // settle loses
    prisma.imageGenItem.findUnique.mockResolvedValue({ id: 1, job: job() });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      tokenUsage: { promptTokens: 3, completionTokens: 4 },
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);
    expect(usage.chargeTokens).not.toHaveBeenCalled();
  });

  it("skips the charge when the provider returned no token usage", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.imageGenItem.findUnique.mockResolvedValue({ id: 1, job: job() });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "SUCCEEDED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      // Spaces URL 免 re-host(mock fetch 无 headers,远端转存路径在单测不可达;
      // 走该路径会触发托管原位重试的 1s+3s 退避,拖爆 jest 超时)
      url: "https://bucket.nyc3.digitaloceanspaces.com/out/no-usage.png",
      tokenUsage: null,
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);
    expect(usage.chargeTokens).not.toHaveBeenCalled();
  });

  it("marks item FAILED with describeImageError message and aggregates FAILED", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // fail settle
    prisma.imageGenItem.findUnique.mockResolvedValue({ id: 1, job: job() });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest
      .fn()
      .mockRejectedValue(new Error("provider call failed（上游返回：503）"));
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);
    const failCall = prisma.imageGenItem.updateMany.mock.calls[1][0];
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("provider call failed");
    expect(prisma.imageGenJob.updateMany.mock.calls[0][0].data.status).toBe("FAILED");
    expect(usage.chargeTokens).not.toHaveBeenCalled();
  });

  it("host 瞬时抖动(Spaces NoSuchBucket 类)原位重试自愈,不重跑 provider", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // settle
    prisma.imageGenItem.findUnique.mockResolvedValue({
      id: 1,
      idx: 0,
      attemptNo: 1,
      job: job(),
    });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "SUCCEEDED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest
      .fn()
      .mockResolvedValue({ url: "data:image/png;base64,AA==", tokenUsage: null });
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    // 前两次 PUT 抖动,第三次成功(退避 1s+3s 真实等待)
    const prevFetch = (globalThis as Record<string, unknown>).fetch;
    (globalThis as Record<string, unknown>).fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("spaces blip 1"))
      .mockRejectedValueOnce(new Error("spaces blip 2"))
      .mockResolvedValue({ ok: true, text: async () => "" });
    try {
      await runner.executeItem(1);
    } finally {
      (globalThis as Record<string, unknown>).fetch = prevFetch;
    }

    expect(generate).toHaveBeenCalledTimes(1); // 只重传产物,不重跑 provider/网关
    const settle = prisma.imageGenItem.updateMany.mock.calls[1][0];
    expect(settle.data.status).toBe("SUCCEEDED");
  }, 15_000);

  it("converges to timeout when job already terminal/expired at claim time", async () => {    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany.mockResolvedValue({ count: 1 });
    prisma.imageGenItem.findUnique.mockResolvedValue({
      id: 1,
      job: job({ status: "COMPLETED" }),
    });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 0 });
    const generate = jest.fn();
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);
    expect(generate).not.toHaveBeenCalled();
    const converge = prisma.imageGenItem.updateMany.mock.calls[1][0];
    expect(converge.data).toEqual(
      expect.objectContaining({ status: "FAILED", errorMessage: "生成超时，请重试" }),
    );
  });

  describe("瞬态进程内重试 (T8)", () => {
    afterEach(() => {
      delete process.env.IMAGE_GEN_INPROCESS_RETRY;
      jest.useRealTimers();
    });

    it("transient RelayError → CAS 退回 QUEUED(清租约)+ 退避后重投,不落 FAILED", async () => {
      const prisma = mockPrisma();
      prisma.imageGenItem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // requeue CAS
      prisma.imageGenItem.findUnique.mockResolvedValue({
        id: 1,
        idx: 0,
        attemptNo: 1,
        job: job(),
      });
      prisma.imageGenItem.findMany.mockResolvedValue([{ status: "QUEUED", usage: null }]);
      const generate = jest
        .fn()
        .mockRejectedValue(
          new RelayError("transient_server", "图像服务繁忙，请稍后重试", "gateway task failed"),
        );
      const { runner, queue } = await makeServices({
        prisma,
        provider: { generate } as Partial<ImageProvider>,
      });
      jest.useFakeTimers();
      await runner.executeItem(1);

      const requeue = prisma.imageGenItem.updateMany.mock.calls[1][0];
      expect(requeue.where).toMatchObject({ id: 1, status: "RUNNING" });
      expect(requeue.data).toEqual({
        status: "QUEUED",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      // 退避第一档 2s 后经调度队列重投
      jest.advanceTimersByTime(2_000);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      // 全程只有 claim + requeue 两次写,没有 FAILED 结算
      const statuses = prisma.imageGenItem.updateMany.mock.calls.map(
        (c) => c[0].data.status,
      );
      expect(statuses).toEqual(["RUNNING", "QUEUED"]);
    });

    it("预算耗尽(attemptNo=3)→ FAILED 带重试上下文,不再重投", async () => {
      const prisma = mockPrisma();
      prisma.imageGenItem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // fail settle
      prisma.imageGenItem.findUnique.mockResolvedValue({
        id: 1,
        idx: 0,
        attemptNo: 3,
        job: job(),
      });
      prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
      prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
      const generate = jest
        .fn()
        .mockRejectedValue(
          new RelayError("transient_timeout", "生成超时，请稍后重试", "poll deadline exceeded"),
        );
      const { runner, queue } = await makeServices({
        prisma,
        provider: { generate } as Partial<ImageProvider>,
      });
      await runner.executeItem(1);
      const fail = prisma.imageGenItem.updateMany.mock.calls[1][0];
      expect(fail.data.status).toBe("FAILED");
      expect(fail.data.errorMessage).toContain("已自动重试 2 次");
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("permanent RelayError → 直接 FAILED,无重投、无重试后缀", async () => {
      const prisma = mockPrisma();
      prisma.imageGenItem.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.imageGenItem.findUnique.mockResolvedValue({
        id: 1,
        idx: 0,
        attemptNo: 1,
        job: job(),
      });
      prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
      prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
      const generate = jest
        .fn()
        .mockRejectedValue(
          new RelayError("permanent_validation", "参数不合法，无法生成此图", "bad size"),
        );
      const { runner, queue } = await makeServices({
        prisma,
        provider: { generate } as Partial<ImageProvider>,
      });
      await runner.executeItem(1);
      const fail = prisma.imageGenItem.updateMany.mock.calls[1][0];
      expect(fail.data.status).toBe("FAILED");
      expect(fail.data.errorMessage).not.toContain("已自动重试");
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("IMAGE_GEN_INPROCESS_RETRY=off → 瞬态也直接失败(基线回退开关)", async () => {
      process.env.IMAGE_GEN_INPROCESS_RETRY = "off";
      const prisma = mockPrisma();
      prisma.imageGenItem.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.imageGenItem.findUnique.mockResolvedValue({
        id: 1,
        idx: 0,
        attemptNo: 1,
        job: job(),
      });
      prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
      prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
      const generate = jest
        .fn()
        .mockRejectedValue(
          new RelayError("transient_server", "图像服务繁忙，请稍后重试", "gateway task failed"),
        );
      const { runner, queue } = await makeServices({
        prisma,
        provider: { generate } as Partial<ImageProvider>,
      });
      await runner.executeItem(1);
      const fail = prisma.imageGenItem.updateMany.mock.calls[1][0];
      expect(fail.data.status).toBe("FAILED");
      expect(fail.data.errorMessage).not.toContain("已自动重试");
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("requeue CAS 输(取消/对账抢先)→ 落常规 FAILED 收敛", async () => {
      const prisma = mockPrisma();
      prisma.imageGenItem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 0 }) // requeue CAS loses
        .mockResolvedValueOnce({ count: 1 }); // fail settle
      prisma.imageGenItem.findUnique.mockResolvedValue({
        id: 1,
        idx: 0,
        attemptNo: 1,
        job: job(),
      });
      prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
      prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
      const generate = jest
        .fn()
        .mockRejectedValue(
          new RelayError("transient_server", "图像服务繁忙，请稍后重试", "gateway task failed"),
        );
      const { runner } = await makeServices({
        prisma,
        provider: { generate } as Partial<ImageProvider>,
      });
      await runner.executeItem(1);
      expect(prisma.imageGenItem.updateMany).toHaveBeenCalledTimes(3);
      const fail = prisma.imageGenItem.updateMany.mock.calls[2][0];
      expect(fail.data.status).toBe("FAILED");
    });

    it("Job 已过墙钟 deadline → 瞬态也不再重投(晚成功不可见,只多花额度)", async () => {
      const prisma = mockPrisma();
      prisma.imageGenItem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // fail settle
      prisma.imageGenItem.findUnique.mockResolvedValue({
        id: 1,
        idx: 0,
        attemptNo: 1,
        // t2i deadline 默认 10 分钟;创建于 15 分钟前
        job: job({ createdAt: new Date(Date.now() - 15 * 60_000) }),
      });
      prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
      prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
      const generate = jest
        .fn()
        .mockRejectedValue(
          new RelayError("transient_server", "图像服务繁忙，请稍后重试", "gateway task failed"),
        );
      const { runner, queue } = await makeServices({
        prisma,
        provider: { generate } as Partial<ImageProvider>,
      });
      await runner.executeItem(1);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(prisma.imageGenItem.updateMany).toHaveBeenCalledTimes(2); // claim + fail,无 requeue
      const fail = prisma.imageGenItem.updateMany.mock.calls[1][0];
      expect(fail.data.status).toBe("FAILED");
      expect(fail.data.errorMessage).not.toContain("已自动重试");
    });
  });
});

// 本文件只验证业务执行；真实文件标识由aigc/image-label.spec.ts覆盖。
jest.mock("../aigc/image-label", () => ({ labelImage: jest.fn((buffer: Buffer) => Promise.resolve({ buffer, mime: "image/png" })) }))
