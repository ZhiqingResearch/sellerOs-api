import { withDeliveryCheckpoint } from "../aigc/test-prisma"
// src/image-generation/image-to-image.spec.ts
//
// i2i 链路单测(mock Prisma + mock Provider + 假 Spaces transport):
//   - 创建校验/默认值/数量上限(契约对齐 Next image-to-image 路由)
//   - 快照投影 queued/running/completed/failed 小写、images 三态、
//     tokenUsage 归一(源 sumUsage 语义)、过期/不存在 404
//   - 执行器 IMAGE_TO_IMAGE 分支:引用图回取、角色/风格/场景附加段、
//     batch 对位引用、失败文案与 Job 聚合

import { Test } from "@nestjs/testing";
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider";
import sharp from "sharp"
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../prisma/prisma.service";
import { UsageService } from "../usage/usage.service";
import { resetSpacesPresignTransport, setSpacesPresignTransport } from "./core/storage";
import type { ImageProvider, ProviderGenerateInput } from "./core/types"
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import {
  ImageGenItemRunnerService,
  type I2IRequestSnapshot,
} from "./executor/image-gen-item-runner.service";
import {
  ImageToImageService,
  type I2IUploadFile,
  type I2IUploadFiles,
} from "./image-to-image.service";
import { IMAGE_PROVIDER_FACTORY } from "./providers/provider-factory.token";

const mockPrisma = () => ({
  aiGatewayModel: { findFirst: jest.fn().mockResolvedValue({
    publicId: "ZQ-Image-2", modality: "IMAGE", enabled: true, gatewayActive: true,
    gatewayConfig: { detail: { facts: { modes: ["edit"], max_reference_images: 10,
      size_capability: { min_pixels: 1048576, max_pixels: 1572864, ratio_min: 0.6667, ratio_max: 1.5 } } } },
  }) },
  imageGenJob: {
    create: jest.fn(),
    findFirst: jest.fn(),
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
    gatewayFixedImageCredits: jest.fn().mockResolvedValue(null),
    gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(1)),
  };
  const provider: ImageProvider = {
    id: "test",
    ...(overrides?.provider ?? {}),
  } as ImageProvider;
  const moduleRef = await Test.createTestingModule({
    providers: [
      ImageToImageService,
      { provide: AiGatewayProvider, useValue: { fetchModelSnapshot: jest.fn().mockResolvedValue({
        detail: { modality: "image", facts: {} }, requestSchema: { request_schema: { type: "object" } },
      }) } },
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
    i2i: moduleRef.get(ImageToImageService),
    gateway: moduleRef.get(AiGatewayProvider),
    runner: moduleRef.get(ImageGenItemRunnerService),
  };
}

function makeFile(field = "main", mime = "image/png"): I2IUploadFile {
  return {
    fieldname: field,
    mimetype: mime,
    buffer: Buffer.from("fake-image-bytes"),
    size: 16,
    originalname: "ref.png",
  };
}

function makeForm(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: "normal",
    prompt: "把产品放到木桌上",
    provider: "atlas-gpt",
    aspectRatio: "1:1",
    ...over,
  });
}

beforeAll(() => {
  setSpacesPresignTransport({
    generateUploadUrl: async () => fakePresign,
  });
  // PUT(托管/上传)→ ok;其余(引用图回取)→ png 字节。
  (globalThis as Record<string, unknown>).fetch = jest.fn(
    (url: unknown, init?: { method?: string }) => {
      const u = String(url);
      if (init?.method === "PUT" || u.startsWith("https://presigned.example")) {
        return Promise.resolve({ ok: true, text: async () => "" });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new TextEncoder().encode("refbytes").buffer,
      });
    },
  );
});

afterAll(() => {
  resetSpacesPresignTransport();
});

// ─── 创建契约 ───────────────────────────────────────────────────────────────

describe("image-to-image create (contract parity)", () => {
  it("未归档局部重绘同样冻结原生比例档位，并传给执行器", async () => {
    const { i2i, prisma, gateway, runner } = await makeServices()
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 21 }])
    jest.spyOn(gateway, "fetchModelSnapshot").mockResolvedValue({
      detail: { modality: "image" },
      requestSchema: { request_schema: { type: "object", properties: {
        aspect_ratio: { enum: ["16:9"] }, resolution: { enum: ["2k"] },
      } } },
    } as never)
    const bytes = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "white" } }).png().toBuffer()
    const main = { ...makeFile(), buffer: bytes }
    const result = await i2i.create({ form: makeForm({ editMode: "local-redraw", resolutionTier: "1K" }),
      localRedrawResolutionTier: "4K",
      files: { main: [main], refs: [{ ...main, fieldname: "refs" }] },
    }, 7)
    expect(result).toMatchObject({ ok: true, localRedraw: { providerApplied: { aspect_ratio: "1920:1080", resolution: "4k" } } })
    const request = prisma.imageGenJob.create.mock.calls[0][0].data.request as I2IRequestSnapshot
    expect(request.resolutionTier).toBe("4K")
    expect((await runner["buildI2IProviderInput"](request, 0)).localRedraw).toMatchObject({
      providerApplied: { aspect_ratio: "1920:1080", resolution: "4k" },
    })
  })

  it("显式局部重绘复用模型和尺寸规则，忽略前端模型和方图尺寸，按实际模型扣费", async () => {
    const prisma = mockPrisma()
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 21 }])
    const { i2i, runner, usage } = await makeServices({ prisma })
    usage.gatewayFixedImageCredits.mockResolvedValue(new Decimal(10))
    Object.assign(usage, { assertExactCreditsAffordable: jest.fn() })
    const bytes = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "white" } }).png().toBuffer()
    const main = { ...makeFile("main"), buffer: bytes }
    const annotated = { ...makeFile("refs"), buffer: bytes }
    const result = await i2i.create({ form: makeForm({ editMode: "local-redraw", provider: "ZQ-Image-3", market: "amazon_mx" }), files: { main: [main], refs: [annotated] } }, 7)
    expect(result).toMatchObject({ ok: true, localRedraw: { provider: "ZQ-Image-2", sourceWidth: 3000, sourceHeight: 2000, generationWidth: 4096, generationHeight: 2731 } })
    const request = prisma.imageGenJob.create.mock.calls[0][0].data.request as I2IRequestSnapshot
    expect(prisma.imageGenJob.create.mock.calls[0][0].data.model).toBe("ZQ-Image-2")
    expect(request.referenceUrls).toHaveLength(2)
    const providerInput = await runner["buildI2IProviderInput"](request, 0)
    expect(providerInput.prompt).toBe("把产品放到木桌上")
    expect(providerInput.localRedraw).toEqual(request.localRedraw)
    expect(usage.gatewayFixedImageCredits).toHaveBeenCalledWith("ZQ-Image-2", "LOCAL_REDRAW")
    await runner["reportUsage"]({ id: "redraw-job", userId: 7, kind: "IMAGE_TO_IMAGE", request }, { costAmountCny: "0.25" }, "imggen:redraw:21:1")
    expect(usage.chargeModel).toHaveBeenCalledWith(7, expect.any(String), expect.objectContaining({ model: "ZQ-Image-2", exactCredits: "10", requestId: "charge:imggen:redraw:21:1" }))
  })

  it("标注尺寸不匹配返回明确业务错误，不创建任务", async () => {
    const { i2i, prisma } = await makeServices()
    const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer()
    const result = await i2i.create({ form: makeForm({ editMode: "local-redraw", provider: undefined, aspectRatio: undefined }), files: {
      main: [{ ...makeFile(), buffer: await png(1500, 1000) }],
      refs: [{ ...makeFile("refs"), buffer: await png(1024, 1024) }],
    } }, 7)
    expect(result).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("标注图必须与原图宽高一致") })
    expect(prisma.imageGenJob.create).not.toHaveBeenCalled()
  })

  it.each(["batch", "unknown"])("局部重绘拒绝 mode=%s，不改变普通批量改图逻辑", async mode => {
    const { i2i, prisma } = await makeServices()
    const result = await i2i.create({ form: makeForm({ mode, editMode: "local-redraw" }), files: { references: [makeFile()] } }, 7)
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(prisma.imageGenJob.create).not.toHaveBeenCalled()
  })

  it.each(["normal", "batch"])("保存 %s 改图的可选站点，不改写用户原始提示词", async mode => {
    const prisma = mockPrisma()
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 21 }])
    const { i2i } = await makeServices({ prisma })
    const files = mode === "batch" ? { references: [makeFile()] } : { main: [makeFile()] }
    const result = await i2i.create(
      { form: makeForm({ mode, market: "  tiktok_mx  " }), files },
      7,
      "vidflowos"
    )
    expect(result.ok).toBe(true)
    const [created] = prisma.imageGenJob.create.mock.calls[0] as [
      { data: { prompt: string; request: I2IRequestSnapshot } },
    ]
    expect(created.data.prompt).toBe("把产品放到木桌上")
    expect(created.data.request.market).toBe("tiktok_mx")
    expect(created.data.request.prompt).toBe("把产品放到木桌上")
  })

  it.each([undefined, "", "   ", null, 123])("空或非字符串站点 %j 不进入执行快照", async market => {
    const prisma = mockPrisma()
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 21 }])
    const { i2i } = await makeServices({ prisma })
    const result = await i2i.create(
      { form: makeForm({ market }), files: { main: [makeFile()] } },
      7
    )
    expect(result.ok).toBe(true)
    const [created] = prisma.imageGenJob.create.mock.calls[0] as [
      { data: { request: Record<string, unknown> } },
    ]
    expect(created.data.request).not.toHaveProperty("market")
  })

  it.each(["platform", "vidflowos"] as const)(
    "writes trusted %s source before dispatch, ignoring form.source",
    async source => {
      const prisma = mockPrisma()
      prisma.imageGenItem.findMany.mockResolvedValue([{ id: 21 }])
      const { i2i, queue } = await makeServices({ prisma })
      await i2i.create(
        { form: makeForm({ source: "spoofed" }), files: { main: [makeFile()] } },
        7,
        source
      )
      expect(prisma.imageGenJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ source, userId: 7 }),
        })
      )
      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(prisma.imageGenJob.create.mock.invocationCallOrder[0]).toBeLessThan(
        queue.enqueue.mock.invocationCallOrder[0]
      )
    }
  )

  it("rejects missing form with Next-identical message", async () => {
    const { i2i } = await makeServices();
    const r = await i2i.create({ form: undefined, files: {} }, 1);
    expect(r).toEqual({
      ok: false,
      status: 400,
      error:
        "Invalid or missing `form` field: form field is undefined, expected string",
    });
  });

  it("rejects non-JSON / non-object / bad fields with exact reasons", async () => {
    const { i2i } = await makeServices();
    expect(await i2i.create({ form: "{oops", files: {} }, 1)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid or missing `form` field: form field is not valid JSON",
    });
    expect(await i2i.create({ form: "42", files: {} }, 1)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid or missing `form` field: form payload is not an object",
    });
    expect(
      await i2i.create({ form: JSON.stringify({ mode: "x", prompt: "p" }), files: {} }, 1),
    ).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid or missing `form` field: bad mode: "x"',
    });
    expect(
      await i2i.create({ form: JSON.stringify({ mode: "normal", prompt: "  " }), files: {} }, 1),
    ).toEqual({
      ok: false,
      status: 400,
      error: "Invalid or missing `form` field: prompt is empty or non-string",
    });
    expect(
      await i2i.create(
        {
          form: JSON.stringify({
            mode: "normal",
            prompt: "p",
            provider: "atlas-wan",
          }),
          files: {},
        },
        1,
      ),
    ).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid or missing `form` field: bad provider: "atlas-wan"',
    });
    expect(
      await i2i.create(
        {
          form: JSON.stringify({
            mode: "normal",
            prompt: "p",
            provider: "atlas-gpt",
            aspectRatio: "0:1",
          }),
          files: {},
        },
        1,
      ),
    ).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid or missing `form` field: bad aspectRatio: "0:1"',
    });
  });

  it("rejects normal mode without main file", async () => {
    const { i2i } = await makeServices();
    const r = await i2i.create({ form: makeForm(), files: { refs: [makeFile("refs")] } }, 1);
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "Main reference image (`main`) is required",
    });
  });

  it("rejects batch mode without / with too many references", async () => {
    const { i2i } = await makeServices();
    expect(await i2i.create({ form: makeForm({ mode: "batch" }), files: {} }, 1)).toEqual({
      ok: false,
      status: 400,
      error: "At least one `references` file is required",
    });
    const references = Array.from({ length: 11 }, () => makeFile("references"));
    expect(
      await i2i.create({ form: makeForm({ mode: "batch" }), files: { references } }, 1),
    ).toEqual({
      ok: false,
      status: 400,
      error: "Batch mode supports up to 10 reference images",
    });
  });

  it.each(["normal", "batch"])("%s 改图保留任意比例与请求清晰度", async mode => {
    for (const aspectRatio of ["64:51", "2048:614", "2:1"]) {
      const { i2i, prisma } = await makeServices()
      prisma.imageGenItem.findMany.mockResolvedValue([])
      const result = await i2i.create({
        form: makeForm({ mode, aspectRatio, resolutionTier: "4K" }),
        files: mode === "normal" ? { main: [makeFile()] } : { references: [makeFile("references")] },
      }, 7)
      expect(result.ok).toBe(true)
      expect(prisma.imageGenJob.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          request: expect.objectContaining({ aspectRatio, resolutionTier: "4K" }),
        }),
      }))
    }
  })

  it("clamps count to provider max (4) after the parseForm cap of 10", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findMany.mockResolvedValue([
      { id: 11 },
      { id: 12 },
      { id: 13 },
      { id: 14 },
    ]);
    const { i2i, queue } = await makeServices({ prisma });
    const r = await i2i.create(
      {
        form: makeForm({ count: 99 }),
        files: { main: [makeFile()] },
      },
      7,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(4);
    expect(r.items).toEqual([
      { index: 0, typeKey: "i2i:normal:0", label: "图 1" },
      { index: 1, typeKey: "i2i:normal:1", label: "图 2" },
      { index: 2, typeKey: "i2i:normal:2", label: "图 3" },
      { index: 3, typeKey: "i2i:normal:3", label: "图 4" },
    ]);
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    expect(created.userId).toBe(7);
    expect(created.kind).toBe("IMAGE_TO_IMAGE");
    expect(created.status).toBe("QUEUED");
    expect(created.items.create).toEqual([
      { idx: 0, label: "图 1", status: "QUEUED" },
      { idx: 1, label: "图 2", status: "QUEUED" },
      { idx: 2, label: "图 3", status: "QUEUED" },
      { idx: 3, label: "图 4", status: "QUEUED" },
    ]);
    expect(queue.enqueue).toHaveBeenCalledTimes(4);
  });

  it("defaults count to 1 and normalizes resolution defaults (1024x1024/1K)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 21 }]);
    const { i2i } = await makeServices({ prisma });
    const r = await i2i.create(
      {
        form: makeForm({ count: undefined }),
        files: { main: [makeFile()] },
      },
      7,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(1);
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    const request = created.request as I2IRequestSnapshot;
    expect(request.resolution).toBe("1024x1024");
    expect(request.resolutionTier).toBe("1K");
    expect(request.count).toBe(1);
  });

  it("persists named slots + refs in order, flags, taskId/traceId and returns them", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 31 }, { id: 32 }]);
    const { i2i, queue } = await makeServices({ prisma });
    const files: I2IUploadFiles = {
      main: [makeFile("main")],
      character: [makeFile("character")],
      style: [makeFile("style")],
      scene: [makeFile("scene")],
      refs: [makeFile("refs", "image/jpeg"), makeFile("refs")],
    };
    const r = await i2i.create({ form: makeForm({ count: 2 }), files }, 9);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(2);
    expect(typeof r.jobId).toBe("string");
    expect(typeof r.taskId).toBe("string");
    expect(typeof r.traceId).toBe("string");
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    expect(created.id).toBe(r.jobId);
    expect(created.traceId).toBe(r.traceId);
    const request = created.request as I2IRequestSnapshot;
    expect(request.kind).toBe("IMAGE_TO_IMAGE");
    expect(request.mode).toBe("normal");
    expect(request.prompt).toBe("把产品放到木桌上");
    expect(request.taskId).toBe(r.taskId);
    expect(request.traceId).toBe(r.traceId);
    // 顺序:main → character → style → scene → refs(源路由 push 顺序)
    expect(request.referenceUrls).toHaveLength(6);
    expect(request.referenceUrls!.every((u) => u === fakePresign.publicUrl)).toBe(true);
    expect(request.hasCharacter).toBe(true);
    expect(request.hasStyle).toBe(true);
    expect(request.hasScene).toBe(true);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("creates one item per references file in batch mode", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 41 }, { id: 42 }, { id: 43 }]);
    const { i2i, queue } = await makeServices({ prisma });
    const r = await i2i.create(
      {
        form: makeForm({ mode: "batch" }),
        files: { references: [makeFile(), makeFile(), makeFile()] },
      },
      9,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(3);
    expect(r.items[2]).toEqual({ index: 2, typeKey: "i2i:batch:2", label: "图 3" });
    const created = prisma.imageGenJob.create.mock.calls[0][0].data;
    const request = created.request as I2IRequestSnapshot;
    expect(request.mode).toBe("batch");
    expect(request.perItemReferenceUrls).toHaveLength(3);
    expect(request.perItemReferenceUrls!.every((g) => g.length === 1)).toBe(true);
    expect(queue.enqueue).toHaveBeenCalledTimes(3);
  });

  it("dispatches openai-gpt-image as a single sequential task (settleTasksSequentially)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findMany.mockResolvedValue([{ id: 51 }, { id: 52 }]);
    prisma.imageGenItem.updateMany.mockResolvedValue({ count: 0 }); // CAS 全输 → 静默
    const { i2i, queue } = await makeServices({ prisma });
    const r = await i2i.create(
      {
        form: makeForm({ provider: "openai-gpt-image", count: 2 }),
        files: { main: [makeFile()] },
      },
      9,
    );
    expect(r.ok).toBe(true);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    // 队列任务内部顺序执行两个 item(这里用两次认领尝试验证覆盖了两个 item)
    const task = queue.enqueue.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(prisma.imageGenItem.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.imageGenItem.updateMany.mock.calls[0][0].where.id).toBe(51);
    expect(prisma.imageGenItem.updateMany.mock.calls[1][0].where.id).toBe(52);
  });
});

// ─── 快照投影 ───────────────────────────────────────────────────────────────

describe("image-to-image snapshot projection", () => {
  const now = Date.now();
  const baseRequest = {
    kind: "IMAGE_TO_IMAGE",
    mode: "normal",
    provider: "atlas-gpt",
    prompt: "p",
    aspectRatio: "1:1",
    resolutionTier: "1K",
    resolution: "1024x1024",
    count: 2,
    taskId: "task-uuid",
    traceId: "trace-uuid",
  };

  function jobRow(over: Record<string, unknown> = {}) {
    return {
      id: "j1",
      userId: 7,
      kind: "IMAGE_TO_IMAGE",
      businessType: "IMAGE_CREATIVE",
      status: "QUEUED",
      request: { ...baseRequest },
      traceId: "trace-uuid",
      tokenUsage: null,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now - 5_000),
      updatedAt: new Date(now - 1_000),
      ...over,
    };
  }

  function itemRow(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      jobId: "j1",
      idx: 0,
      label: "图 1",
      status: "QUEUED",
      url: null,
      errorMessage: null,
      usage: null,
      updatedAt: new Date(now - 900),
      ...over,
    };
  }

  it("projects queued while items are QUEUED", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findFirst.mockResolvedValue(
      jobRow({ items: [itemRow(), itemRow({ id: 2, idx: 1, label: "图 2" })] }),
    );
    const { i2i } = await makeServices({ prisma });
    const snapshot = await i2i.getSnapshot("j1", 7);
    expect(snapshot).toMatchObject({
      jobId: "j1",
      taskId: "task-uuid",
      traceId: "trace-uuid",
      status: "queued",
      submittedAt: now - 5_000,
    });
    expect(snapshot!.images).toEqual([
      { index: 0, typeKey: "i2i:normal:0", label: "图 1", status: "pending" },
      { index: 1, typeKey: "i2i:normal:1", label: "图 2", status: "pending" },
    ]);
    expect(snapshot!.tokenUsage).toBeUndefined();
    expect(snapshot!.completedAt).toBeUndefined();
  });

  it("projects running once any item left QUEUED", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findFirst.mockResolvedValue(
      jobRow({
        status: "RUNNING",
        items: [
          itemRow({ status: "SUCCEEDED", url: "https://cdn.example/a.png" }),
          itemRow({ id: 2, idx: 1, label: "图 2", status: "RUNNING" }),
        ],
      }),
    );
    const { i2i } = await makeServices({ prisma });
    expect((await i2i.getSnapshot("j1", 7))!.status).toBe("running");
  });

  it("projects completed with ready/failed images, tokenUsage fallback and mcpUsage zeros", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findFirst.mockResolvedValue(
      jobRow({
        status: "COMPLETED",
        tokenUsage: { promptTokens: 3, completionTokens: 4 },
        items: [
          itemRow({
            status: "SUCCEEDED",
            url: "https://cdn.example/hosted.png",
            gatewayImage: { width: 819, height: 1024, originalUrl: "https://stored.example/original.png" },
          }),
          itemRow({
            id: 2,
            idx: 1,
            label: "图 2",
            status: "FAILED",
            errorMessage: "上游错误",
          }),
        ],
      }),
    );
    const { i2i } = await makeServices({ prisma });
    const snapshot = await i2i.getSnapshot("j1", 7);
    expect(snapshot!.status).toBe("completed");
    expect(snapshot!.completedAt).toBe(snapshot!.updatedAt);
    expect(snapshot!.images[0]).toMatchObject({
      originalUrl: "https://stored.example/original.png",
      index: 0,
      typeKey: "i2i:normal:0",
      label: "图 1",
      status: "ready",
      url: "https://cdn.example/hosted.png",
      mimeType: "image/png",
      gatewayImage: { width: 819, height: 1024 },
    });
    expect(snapshot!.images[1]).toEqual({
      index: 1,
      typeKey: "i2i:normal:1",
      label: "图 2",
      status: "failed",
      errorMessage: "上游错误",
    });
    // 源 sumUsage:totalTokens 缺省回退 prompt+completion;mcpUsage 恒 0
    expect(snapshot!.tokenUsage).toEqual({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
    });
    expect(snapshot!.mcpUsage).toEqual({ totalCalls: 0, callDetail: {} });
  });

  it("keeps completed even when every image failed (source allSettled parity)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findFirst.mockResolvedValue(
      jobRow({
        status: "FAILED",
        tokenUsage: {},
        items: [
          itemRow({ status: "FAILED", errorMessage: "provider call failed" }),
          itemRow({
            id: 2,
            idx: 1,
            label: "图 2",
            status: "FAILED",
            errorMessage: "provider call failed",
          }),
        ],
      }),
    );
    const { i2i } = await makeServices({ prisma });
    const snapshot = await i2i.getSnapshot("j1", 7);
    expect(snapshot!.status).toBe("completed");
    expect(snapshot!.tokenUsage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("normalizes thinkingTokens (kept when > 0, dropped when 0)", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findFirst
      .mockResolvedValueOnce(
        jobRow({
          status: "COMPLETED",
          tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 2 },
          items: [itemRow({ status: "SUCCEEDED", url: "https://cdn.example/a.png" })],
        }),
      )
      .mockResolvedValueOnce(
        jobRow({
          status: "COMPLETED",
          tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
          items: [itemRow({ status: "SUCCEEDED", url: "https://cdn.example/a.png" })],
        }),
      );
    const { i2i } = await makeServices({ prisma });
    expect((await i2i.getSnapshot("j1", 7))!.tokenUsage).toEqual({
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      thinkingTokens: 2,
    });
    expect((await i2i.getSnapshot("j1", 7))!.tokenUsage).toEqual({
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });
  });

  it("uses batch typeKey for batch jobs and returns null when missing/expired/foreign", async () => {
    const prisma = mockPrisma();
    prisma.imageGenJob.findFirst
      .mockResolvedValueOnce(
        jobRow({
          request: { ...baseRequest, mode: "batch" },
          items: [itemRow({ idx: 2, label: "图 3" })],
        }),
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(jobRow({ expiresAt: new Date(now - 1), items: [itemRow()] }));
    const { i2i } = await makeServices({ prisma });
    const batch = await i2i.getSnapshot("j1", 7);
    expect(batch!.images[0].typeKey).toBe("i2i:batch:2");
    expect(await i2i.getSnapshot("gone", 7)).toBeNull();
    expect(await i2i.getSnapshot("j1", 7)).toBeNull();
  });
});

// ─── 执行器 i2i 分支 ────────────────────────────────────────────────────────

describe("image-gen item runner (IMAGE_TO_IMAGE branch)", () => {
  const i2iRequest = (over: Record<string, unknown> = {}) => ({
    kind: "IMAGE_TO_IMAGE",
    provider: "atlas-gpt",
    prompt: "p",
    aspectRatio: "16:9",
    resolutionTier: "2K",
    resolution: "1536x1024",
    mode: "normal",
    count: 2,
    referenceUrls: ["https://cdn.example/ref0.png", "https://cdn.example/ref1.png"],
    hasCharacter: true,
    hasStyle: true,
    hasScene: true,
    taskId: "task-uuid",
    traceId: "trace-uuid",
    ...over,
  });

  function job(over: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      userId: 7,
      kind: "IMAGE_TO_IMAGE",
      businessType: "IMAGE_CREATIVE",
      status: "RUNNING",
      expiresAt: new Date(Date.now() + 60_000),
      request: i2iRequest(),
      ...over,
    };
  }

  it.each([
    ["normal", "tiktok_us", "ENGLISH (EN-US)", "English"],
    ["normal", "amazon_mx", "SPANISH (ES-MX)", "Spanish"],
    ["normal", "ozon_ru", "RUSSIAN (RU-RU)", "Russian"],
    ["normal", "unknown_xx", "ENGLISH (EN-US)", "English"],
    ["batch", "tiktok_us", "ENGLISH (EN-US)", "English"],
    ["batch", "amazon_mx", "SPANISH (ES-MX)", "Spanish"],
    ["batch", "ozon_ru", "RUSSIAN (RU-RU)", "Russian"],
    ["batch", "unknown_xx", "ENGLISH (EN-US)", "English"],
  ])("%s 改图执行时使用站点 %s 的语言规则", async (mode, market, heading, language) => {
    const prisma = mockPrisma()
    prisma.imageGenItem.updateMany.mockResolvedValue({ count: 1 })
    prisma.imageGenItem.findUnique.mockResolvedValue({
      id: 1,
      idx: 0,
      job: job({
        request: i2iRequest({
          mode,
          market,
          prompt: "将中文卖点替换为目标站点语言，保持商品不变",
          perItemReferenceUrls: [["https://cdn.example/batch.png"]],
        }),
      }),
    })
    prisma.imageGenItem.findMany.mockResolvedValue([{ status: "SUCCEEDED", usage: null }])
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 })
    const generate = jest
      .fn<Promise<{ url: string }>, [ProviderGenerateInput]>()
      .mockResolvedValue({ url: "data:image/png;base64,AA==" })
    const { runner } = await makeServices({ prisma, provider: { generate } })
    await runner.executeItem(1)
    const [input] = generate.mock.calls[0]
    expect(input.prompt.startsWith(`LANGUAGE=${heading}. STRICT RULE:`)).toBe(true)
    expect(input.prompt).toContain(`translate all on-image copy into ${language}`)
    expect(input.prompt).toContain("将中文卖点替换为目标站点语言，保持商品不变")
    expect(input.prompt).toContain(
      `Final reminder: every glyph rendered in the output image must be in ${language}`
    )
    expect(input.prompt.includes("附加要求")).toBe(mode === "normal")
    expect(input.referenceImages.map(image => image.url)).toEqual(
      mode === "batch"
        ? ["https://cdn.example/batch.png"]
        : ["https://cdn.example/ref0.png", "https://cdn.example/ref1.png"]
    )
  })

  it("builds provider input with references, prompt extensions and settles via CAS", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // settle
    prisma.imageGenItem.findUnique.mockResolvedValue({
      id: 1,
      idx: 0,
      job: job(),
    });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([
      { status: "SUCCEEDED", usage: { promptTokens: 3, completionTokens: 4 } },
    ]);
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

    // 计费统一:成功 item 服务端扣费,source 与 generate/t2i 一致。
    expect(usage.chargeTokens).toHaveBeenCalledWith(
      7,
      {
        promptTokens: 3,
        completionTokens: 4,
        thinkingTokens: undefined,
        source: "aicreative.image_generate",
        meta: {
          jobId: "job-1",
          kind: "IMAGE_TO_IMAGE",
          provider: "atlas-gpt",
          imageCount: 1,
          gatewayTaskId: "", // token 路径防御性盖章(本用例 generate 结果未带网关任务 id)
        },
      },
      { invokeType: "PLATFORM" }
    )

    const expectedBase64 = Buffer.from("refbytes").toString("base64");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: [
          {
            mimeType: "image/png",
            base64: expectedBase64,
            url: "https://cdn.example/ref0.png",
          },
          {
            mimeType: "image/png",
            base64: expectedBase64,
            url: "https://cdn.example/ref1.png",
          },
        ],
        prompt:
          "p" +
          "。附加要求：请确保画面中包含参考图中的人物/模特，使其自然地展示或与产品互动。" +
          "。附加要求：请参考提供的“细节/风格”参考图来渲染产品的质感、光影或整体画面的美术风格。" +
          "。附加要求：请参考提供的“结构/场景”参考图来构建画面背景和空间关系。",
        aspectRatio: "16:9",
        resolutionTier: "2K",
        resolution: "1536x1024",
        authToken: "",
      }),
    );
    const settle = prisma.imageGenItem.updateMany.mock.calls[1][0];
    expect(settle.where).toEqual({ id: 1, status: "RUNNING" });
    expect(settle.data.status).toBe("SUCCEEDED");
    expect(settle.data.url).toBe(fakePresign.publicUrl);
    expect(prisma.imageGenJob.updateMany.mock.calls[0][0].data).toEqual({
      status: "COMPLETED",
      tokenUsage: { promptTokens: 3, completionTokens: 4 },
    });
  });

  it("uses per-item references in batch mode and skips prompt extensions", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.imageGenItem.findUnique.mockResolvedValue({
      id: 2,
      idx: 1,
      job: job({
        request: i2iRequest({
          mode: "batch",
          referenceUrls: undefined,
          hasCharacter: undefined,
          hasStyle: undefined,
          hasScene: undefined,
          perItemReferenceUrls: [
            ["https://cdn.example/refA.png"],
            ["https://cdn.example/refB.png"],
          ],
        }),
      }),
    });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "SUCCEEDED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
    });
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(2);
    const input = generate.mock.calls[0][0];
    expect(input.prompt).toBe("p"); // batch 模式不附加角色/风格/场景段
    expect(input.referenceUrls).toBeUndefined();
    expect(input.referenceImages).toEqual([
      {
        mimeType: "image/png",
        base64: Buffer.from("refbytes").toString("base64"),
        url: "https://cdn.example/refB.png",
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cdn.example/refB.png",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("marks item FAILED with describeImageError message and aggregates FAILED", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.imageGenItem.findUnique.mockResolvedValue({
      id: 1,
      idx: 0,
      job: job(),
    });
    prisma.imageGenItem.findMany.mockResolvedValueOnce([{ status: "FAILED", usage: null }]);
    prisma.imageGenJob.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest
      .fn()
      .mockRejectedValue(new Error("provider call failed（上游返回：503）"));
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });
    await runner.executeItem(1);
    const failCall = prisma.imageGenItem.updateMany.mock.calls[1][0];
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("provider call failed");
    expect(prisma.imageGenJob.updateMany.mock.calls[0][0].data.status).toBe("FAILED");
  });
});

// 本文件只验证业务执行；真实文件标识由aigc/image-label.spec.ts覆盖。
jest.mock("../aigc/image-label", () => ({ labelImage: jest.fn((buffer: Buffer) => Promise.resolve({ buffer, mime: "image/png" })) }))
