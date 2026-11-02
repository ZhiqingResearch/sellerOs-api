import { withDeliveryCheckpoint } from "../aigc/test-prisma"
// src/image-generation/generate.spec.ts
//
// 主生图(generate)链路单测(mock Prisma + mock Provider + 假 Spaces transport
// + mock ImageProjectService/UsageService):
//   - 创建校验契约(文案逐条对齐 Next generate 路由,单一 400 消息)
//   - mode 分支 prompt 选择(IMAGE_PROMPT_STRUCTURED 开关 / promptOverride /
//     legacy buildImagePrompt)
//   - 建任务载荷字段(model 别名、archivedPrompt、generatedImages children、
//     refImageUrls、executionSpec 引用图顺序契约)
//   - 执行器成功/失败/部分成功/交付降级/超时前置收敛
//   - 取消竞态(取消后晚到成功被 settle CAS 挡住、usage 不计费、abort 在途)
//   - 对账扩展(租约过期重投 + 超 deadline TIMEOUT 收敛)
//   - usage 仅成功图上报(source/meta 口径照源 reportImageGenerationUsage)

import { Test } from "@nestjs/testing";
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider";
import sharp from "sharp"
import { Decimal } from "@prisma/client/runtime/library";
import sharp from "sharp";
import { ImageProjectService } from "../image-project/image-project.service";
import { PrismaService } from "../prisma/prisma.service";
import { UsageService } from "../usage/usage.service";
import { plan } from "./core/delivery-planner";
import * as deliveryFinalize from "./core/delivery-finalize";
import { imageCreationRenderLevelForProvider } from "./core/image-creation-render-level";
import {
  buildImageCreationPrompt,
  buildImageCreationPromptStructured,
  buildImagePrompt,
} from "./core/prompt-builder";
import { resolveTargetImageSize } from "./core/size-adapters";
import { resetSpacesPresignTransport, setSpacesPresignTransport } from "./core/storage";
import type { ImageProvider } from "./core/types";
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import {
  GenerationTaskRunnerService,
  type GenerationExecutionSpec,
} from "./executor/generation-task-runner.service";
import type { ImageGenItemRunnerService } from "./executor/image-gen-item-runner.service";
import { ReconciliationService } from "./executor/reconciliation.service";
import { GenerateService, type GenerateUploadFile } from "./generate.service";
import { IMAGE_PROVIDER_FACTORY } from "./providers/provider-factory.token";

// ─── mocks ──────────────────────────────────────────────────────────────────

interface MockPrisma {
  aiGatewayModel: { findFirst: jest.Mock };
  imageProject: { findUnique: jest.Mock }
  generationTask: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  generatedImage: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  imageGenJob: { findMany: jest.Mock; deleteMany: jest.Mock };
  imageGenItem: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function mockPrisma(): MockPrisma {
  const prisma: MockPrisma = {
    aiGatewayModel: { findFirst: jest.fn().mockResolvedValue({
      publicId: "ZQ-Image-2", enabled: true, gatewayActive: true, modality: "IMAGE",
      gatewayConfig: { detail: { facts: { modes: ["edit"], max_reference_images: 10,
        size_capability: { min_pixels: 1048576, max_pixels: 1572864, ratio_min: 0.6667, ratio_max: 1.5 } } } },
    }) },
    imageProject: { findUnique: jest.fn().mockResolvedValue({ id: 41 }) },
    generationTask: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    generatedImage: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    imageGenJob: { findMany: jest.fn(), deleteMany: jest.fn() },
    imageGenItem: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  // 回调形式与数组形式都支持(retry 用数组形式批量原子写)。
  prisma.$transaction.mockImplementation(
    async (arg: unknown): Promise<unknown> =>
      Array.isArray(arg)
        ? Promise.all(arg as Promise<unknown>[])
        : (arg as (tx: MockPrisma) => Promise<unknown>)(prisma),
  );
  return prisma;
}

const fakePresign = {
  uploadUrl: "https://presigned.example/put",
  publicUrl: "https://cdn.example/hosted.png",
  headers: { "x-amz-acl": "public-read" },
};

const fetchMock = jest.fn();

async function mockLocalReferences() {
  const bytes = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "white" } }).png().toBuffer()
  const response = { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
  fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(response)
}

async function makeServices(overrides?: {
  prisma?: MockPrisma;
  provider?: Partial<ImageProvider>;
  imageProject?: { createTask: jest.Mock };
  usage?: { chargeTokens: jest.Mock };
}) {
  const prisma = overrides?.prisma ?? mockPrisma();
  const provider: ImageProvider = {
    id: "test",
    ...(overrides?.provider ?? {}),
  } as ImageProvider;
  const imageProject = overrides?.imageProject ?? { createTask: jest.fn() };
  const usage = overrides?.usage ?? { chargeTokens: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GenerateService,
      { provide: AiGatewayProvider, useValue: { fetchModelSnapshot: jest.fn().mockResolvedValue({
        detail: { modality: "image", facts: {} }, requestSchema: { request_schema: { type: "object" } },
      }) } },
      GenerationTaskRunnerService,
      { provide: DispatchQueueService, useValue: { enqueue: jest.fn() } },
      { provide: PrismaService, useValue: withDeliveryCheckpoint(prisma) },
      { provide: ImageProjectService, useValue: imageProject },
      { provide: UsageService, useValue: usage },
      { provide: IMAGE_PROVIDER_FACTORY, useValue: () => provider },
    ],
  }).compile();
  return {
    prisma,
    imageProject,
    usage,
    queue: moduleRef.get(DispatchQueueService) as unknown as {
      enqueue: jest.Mock;
    },
    generate: moduleRef.get(GenerateService),
    gateway: moduleRef.get(AiGatewayProvider),
    runner: moduleRef.get(GenerationTaskRunnerService),
  };
}

function makeFile(field = "mainImages", mime = "image/png"): GenerateUploadFile {
  return {
    fieldname: field,
    mimetype: mime,
    buffer: Buffer.from("fake-image-bytes"),
    size: 16,
    originalname: "ref.png",
  };
}

function makeCreationForm(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: "image-creation",
    projectId: "5",
    prompt: "画一张海报",
    provider: "atlas-gpt",
    aspectRatio: "1:1",
    count: 2,
    targetLanguage: "zh",
    ...over,
  });
}

function makeLegacyForm(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: "product-image",
    projectId: "5",
    productName: "保温杯",
    categoryL1: "Home",
    categoryL2: "Kitchen",
    provider: "gemini-nano-banana",
    aspectRatio: "1:1",
    imageTypes: ["scene"],
    customTypes: ["自定义卖点图"],
    targetLanguage: "zh",
    ...over,
  });
}

function makeTaskRecord(id = 9001, n = 2) {
  return {
    id,
    projectId: 5,
    userId: 7,
    generatedImages: Array.from({ length: n }, (_, i) => ({
      id: 10 + i,
      order: i,
    })),
  };
}

beforeAll(() => {
  setSpacesPresignTransport({
    generateUploadUrl: async () => fakePresign,
  });
  // PUT(托管/上传)→ ok;其余(引用图回取/URL 主图探活)→ png 字节。
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  fetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
    const u = String(url);
    if (init?.method === "PUT" || u.startsWith("https://presigned.example")) {
      return Promise.resolve({ ok: true, text: async () => "" });
    }
    return Promise.resolve({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new TextEncoder().encode("refbytes").buffer,
    });
  });
});

afterAll(() => {
  resetSpacesPresignTransport();
});

async function untilCalled(mock: { mock: { calls: unknown[] } }): Promise<void> {
  for (let i = 0; i < 200 && mock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(mock.mock.calls.length).toBeGreaterThan(0);
}

// ─── 创建契约(校验/错误文案)─────────────────────────────────────────────────

describe("generate create (contract parity)", () => {
  it("rejects a VidFlow project before uploading references or dispatching", async () => {
    const prisma = mockPrisma()
    prisma.imageProject.findUnique.mockResolvedValue(null)
    const { generate, imageProject, queue } = await makeServices({ prisma })
    expect(
      await generate.create({ form: makeCreationForm(), files: { mainImages: [makeFile()] } }, 7)
    ).toEqual({ ok: false, status: 404, error: "项目不存在" })
    expect(prisma.imageProject.findUnique).toHaveBeenCalledWith({
      where: { id: 5, userId: 7, source: "platform" },
      select: { id: true },
    })
    expect(imageProject.createTask).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it("forwards internal source to shared task creation", async () => {
    const prisma = mockPrisma()
    const imageProject = { createTask: jest.fn().mockResolvedValue(makeTaskRecord()) }
    const { generate } = await makeServices({ prisma, imageProject })
    const result = await generate.create(
      { form: makeCreationForm(), files: { mainImages: [makeFile()] } },
      7,
      "vidflowos"
    )
    expect(result.ok).toBe(true)
    expect(prisma.imageProject.findUnique).toHaveBeenCalledWith({
      where: { id: 5, userId: 7, source: "vidflowos" },
      select: { id: true },
    })
    expect(imageProject.createTask).toHaveBeenCalledWith(5, expect.any(Object), 7, "vidflowos")
  })

  const reject = { ok: false, status: 400, error: "Invalid or missing `form` field" };

  it.each(["64:51", "2048:614", "2:1"])("普通及 VidFlow 生图保留自定义比例 %s", async aspectRatio => {
    for (const source of ["platform", "vidflowos"] as const) {
      const prisma = mockPrisma()
      const imageProject = { createTask: jest.fn().mockResolvedValue(makeTaskRecord(9001, 1)) }
      const { generate } = await makeServices({ prisma, imageProject })
      const result = await generate.create({
        form: makeCreationForm({
          imageCreationVariant: "ecommerce", market: "amazon_us", provider: "ZQ-Image-2",
          aspectRatio, resolutionTier: "4K", resolution: "4096x3264", count: 1,
          prompt: "调整商品背景",
        }),
        files: { mainImages: [makeFile()], attachedRefs: [makeFile("attachedRefs")] },
      }, 7, source)
      expect(result.ok).toBe(true)
      expect(imageProject.createTask).toHaveBeenCalledWith(
        5, expect.objectContaining({ aspectRatio }), 7, source
      )
      expect(prisma.generationTask.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ executionSpec: expect.objectContaining({
          form: expect.objectContaining({ aspectRatio, resolutionTier: "4K" }),
        }) }),
      }))
    }
  })

  it("rejects every parseForm failure with the single Next-identical message", async () => {
    const { generate } = await makeServices();
    // form 缺失 / 非 JSON / 非对象
    expect(await generate.create({ form: undefined, files: {} }, 7)).toEqual(reject);
    expect(await generate.create({ form: "{oops", files: {} }, 7)).toEqual(reject);
    expect(await generate.create({ form: "42", files: {} }, 7)).toEqual(reject);
    // provider 为退役槽位(B4)/ aspectRatio 非法;动态 model id 不在此列(放行)
    expect(
      await generate.create({ form: makeCreationForm({ provider: "atlas-wan" }), files: {} }, 7),
    ).toEqual(reject);
    expect(
      await generate.create({ form: makeCreationForm({ aspectRatio: "0:1" }), files: {} }, 7),
    ).toEqual(reject);
    // legacy 模式必填 productName / 至少一个 imageType|customType
    expect(
      await generate.create(
        {
          form: makeLegacyForm({ productName: 42 }),
          files: { main: [makeFile("main")] },
        },
        7,
      ),
    ).toEqual(reject);
    expect(
      await generate.create(
        {
          form: makeLegacyForm({ imageTypes: [], customTypes: [] }),
          files: { main: [makeFile("main")] },
        },
        7,
      ),
    ).toEqual(reject);
  });

  it("requires projectId (backend runner needs the GenerationTask row)", async () => {
    const { generate } = await makeServices();
    const r = await generate.create(
      { form: makeCreationForm({ projectId: undefined }), files: { mainImages: [makeFile()] } },
      7,
    );
    expect(r).toEqual({ ok: false, status: 400, error: "`projectId` is required" });
  });

  it("requires the main file in legacy product-image mode", async () => {
    const { generate } = await makeServices();
    const r = await generate.create({ form: makeLegacyForm(), files: {} }, 7);
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "Main reference image (`main`) is required",
    });
  });

  it("rejects unreachable url main images with the Next-identical message", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 404, text: async () => "" }),
    );
    const { generate } = await makeServices();
    const r = await generate.create(
      {
        form: makeCreationForm({ mainImageUrls: ["https://dead.example/x.png"] }),
        files: {},
      },
      7,
    );
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "Failed to read uploaded images",
    });
  });

  it("returns 502 when task registration fails", async () => {
    const { generate } = await makeServices({
      imageProject: {
        createTask: jest.fn().mockRejectedValue(new Error("项目不存在")),
      },
    });
    const r = await generate.create(
      { form: makeCreationForm(), files: { mainImages: [makeFile()] } },
      7,
    );
    expect(r).toEqual({
      ok: false,
      status: 502,
      error: "无法连接后端服务（in-process）：项目不存在",
    });
  });
});

// ─── prompt 编译 + 建任务载荷 ────────────────────────────────────────────────

describe("generate create (prompt compilation + task payload)", () => {
  it("image-creation default: legacy creation prompt, refs uploaded, exact createTask payload", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord()),
    };
    const { generate, queue } = await makeServices({ prisma, imageProject });
    const files = {
      mainImages: [makeFile()],
      attachedRefs: [makeFile("attachedRefs", "image/jpeg")],
    };
    const r = await generate.create(
      { form: makeCreationForm({ displayPrompt: "用户手打 brief" }), files },
      7,
    );
    expect(r).toEqual({
      ok: true,
      taskId: 9001,
      generatedImages: [
        { id: 10, order: 0, status: "GENERATING" },
        { id: 11, order: 1, status: "GENERATING" },
      ],
    });

    // 建任务载荷字段与源 createTaskDto 完全一致
    const [projectIdArg, dto, userIdArg] = imageProject.createTask.mock.calls[0];
    expect(projectIdArg).toBe(5);
    expect(userIdArg).toBe(7);
    expect(dto).toEqual({
      presetCategory: "custom",
      model: "ZQ-Image-2 备用", // atlas-gpt → IMAGE_PROVIDER_LABELS 别名
      prompt: "用户手打 brief", // displayPrompt 优先(照源)
      language: "zh",
      aspectRatio: "1:1",
      n: 2,
      refImageUrls: [fakePresign.publicUrl, fakePresign.publicUrl],
      status: "GENERATING",
      generatedImages: [
        { order: 0, status: "GENERATING" },
        { order: 1, status: "GENERATING" },
      ],
    });

    // executionSpec + deadline(创建 + 11 分钟)
    const updateArg = prisma.generationTask.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 9001 });
    expect(updateArg.data.deadlineAt.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    const spec = updateArg.data.executionSpec as GenerationExecutionSpec;
    expect(spec.kind).toBe("IMAGE_CREATIVE_GENERATE");
    expect(spec.mode).toBe("image-creation");
    expect(spec.mainCount).toBe(1);
    expect(spec.paperclipAttachedCount).toBe(1);
    expect(spec.referenceUrls).toEqual([fakePresign.publicUrl, fakePresign.publicUrl]);
    const expectedPrompt = buildImageCreationPrompt({
      prompt: "画一张海报",
      attachedRefsCount: 1,
      mainRefsCount: 1,
      mainRefsLabels: [],
      aspectRatio: "1:1",
      resolution: resolveTargetImageSize({
        aspectRatio: "1:1",
        resolutionTier: "1K",
      }).size,
      targetLanguage: "zh",
    });
    expect(spec.taskPrompt).toBe(expectedPrompt);

    // atlas-gpt 非 openai-gpt-image → 每图一个队列任务(并行范式)
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("market=amazon_mx → 编译 prompt 以站点商城语言硬指令包裹（覆盖 zh 缺省）", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord()),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    const r = await generate.create(
      { form: makeCreationForm({ market: "amazon_mx" }), files: { mainImages: [makeFile()] } },
      7,
    );
    expect(r.ok).toBe(true);
    const spec = prisma.generationTask.update.mock.calls[0][0].data
      .executionSpec as GenerationExecutionSpec;
    expect(spec.taskPrompt).toContain("LANGUAGE=SPANISH (ES-MX). STRICT RULE:");
    expect(spec.taskPrompt).toContain("translate all on-image copy into Spanish");
    expect(spec.taskPrompt).not.toContain("语言=简体中文");
    // 归档 prompt 不受影响（仍存用户原文口径）。
    expect(imageProject.createTask.mock.calls[0][1].prompt).toBe("画一张海报");
  });

  it("market 解析不出国家 → 回落英文硬指令", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord()),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    const r = await generate.create(
      { form: makeCreationForm({ market: "mars_x1" }), files: { mainImages: [makeFile()] } },
      7,
    );
    expect(r.ok).toBe(true);
    const spec = prisma.generationTask.update.mock.calls[0][0].data
      .executionSpec as GenerationExecutionSpec;
    expect(spec.taskPrompt).toContain("LANGUAGE=ENGLISH (EN-US). STRICT RULE:");
    expect(spec.taskPrompt).not.toContain("语言=简体中文");
  });

  it.each([
    ["off", undefined],
    ["off", "参考图标题 LAPTOP，改成产品海报"],
    ["on", undefined],
    ["on", "参考图标题 LAPTOP，改成产品海报"],
  ])("Ozon RU 在 structured=%s、override=%s 时都使用俄语指令", async (flag, promptOverride) => {
    const previousFlag = process.env.IMAGE_PROMPT_STRUCTURED;
    process.env.IMAGE_PROMPT_STRUCTURED = flag;
    try {
      const prisma = mockPrisma();
      const imageProject = {
        createTask: jest.fn().mockResolvedValue(makeTaskRecord()),
      };
      const { generate } = await makeServices({ prisma, imageProject });
      const r = await generate.create(
        {
          form: makeCreationForm({
            market: "ozon_ru",
            prompt: "INTEL n95，512G，14寸，保修2年",
            promptOverride,
          }),
          files: { mainImages: [makeFile()] },
        },
        7,
      );
      expect(r.ok).toBe(true);
      const spec = prisma.generationTask.update.mock.calls[0][0].data
        .executionSpec as GenerationExecutionSpec;
      expect(spec.taskPrompt).toContain("LANGUAGE=RUSSIAN (RU-RU). STRICT RULE:");
      expect(spec.taskPrompt).toContain("translate all on-image copy into Russian");
      expect(spec.taskPrompt).toContain("must be in Russian (ru-RU)");
      expect(spec.taskPrompt).not.toContain("MUST be written in English only");
      expect(spec.taskPrompt).not.toContain("语言=简体中文");
      expect(spec.taskPrompt).toContain(promptOverride ?? "INTEL n95，512G，14寸，保修2年");
    } finally {
      if (previousFlag === undefined) delete process.env.IMAGE_PROMPT_STRUCTURED;
      else process.env.IMAGE_PROMPT_STRUCTURED = previousFlag;
    }
  });

  it.each([{ textDensity: "none" }, { targetLanguage: "none" }])(
    "无文字 override 不注入站点文字要求：%j",
    async (textRule) => {
      const prisma = mockPrisma();
      const imageProject = { createTask: jest.fn().mockResolvedValue(makeTaskRecord()) };
      const { generate } = await makeServices({ prisma, imageProject });
      await generate.create(
        {
          form: makeCreationForm({ market: "ozon_ru", promptOverride: "不要任何文字", ...textRule }),
          files: {},
        },
        7,
      );
      const spec = prisma.generationTask.update.mock.calls[0][0].data
        .executionSpec as GenerationExecutionSpec;
      expect(spec.taskPrompt).toBe("不要任何文字");
    },
  );

  it("market 缺省 → 编译 prompt 与现状一致（中文硬指令，无站点语言指令）", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord()),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    await generate.create(
      { form: makeCreationForm(), files: { mainImages: [makeFile()] } },
      7,
    );
    const spec = prisma.generationTask.update.mock.calls[0][0].data
      .executionSpec as GenerationExecutionSpec;
    expect(spec.taskPrompt).toContain("语言=简体中文");
    expect(spec.taskPrompt).not.toContain("STRICT RULE: Any text, captions");
  });

  it("IMAGE_PROMPT_STRUCTURED=on routes the brief through the structured compiler (no raw bypass)", async () => {
    process.env.IMAGE_PROMPT_STRUCTURED = "on";
    try {
      const prisma = mockPrisma();
      const imageProject = {
        createTask: jest.fn().mockResolvedValue(makeTaskRecord(9002, 1)),
      };
      const { generate } = await makeServices({ prisma, imageProject });
      const r = await generate.create(
        {
          form: makeCreationForm({
            count: 1,
            promptOverride: "按这个 brief 出图",
            textDensity: "minimal",
          }),
          files: { mainImages: [makeFile()] },
        },
        7,
      );
      expect(r.ok).toBe(true);
      const spec = prisma.generationTask.update.mock.calls[0][0].data
        .executionSpec as GenerationExecutionSpec;
      const expected = buildImageCreationPromptStructured(
        {
          prompt: "按这个 brief 出图", // promptOverride 作为 user brief
          mainRefsCount: 1,
          mainRefsLabels: [],
          attachedRefsCount: 0,
          attachedRefsSources: [],
          attachedRefsChipNumbers: [],
          attachedRefsChipTokens: [],
          targetLanguage: "zh",
          textDensity: "minimal",
          aspectRatio: "1:1",
          resolution: "1024x1024",
        },
        { renderLevel: imageCreationRenderLevelForProvider("atlas-gpt") },
      );
      expect(spec.taskPrompt).toBe(expected.prompt);
      expect(spec.taskPrompt).not.toBe("按这个 brief 出图");
    } finally {
      delete process.env.IMAGE_PROMPT_STRUCTURED;
    }
  });

  it("image-creation with promptOverride passes it through verbatim (structured off)", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord(9002, 1)),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    await generate.create(
      {
        form: makeCreationForm({ count: 1, promptOverride: "OVERRIDE-PROMPT" }),
        files: {},
      },
      7,
    );
    const spec = prisma.generationTask.update.mock.calls[0][0].data
      .executionSpec as GenerationExecutionSpec;
    expect(spec.taskPrompt).toBe("OVERRIDE-PROMPT");
  });

  it("局部重绘命中能力时冻结原生比例档位，忽略前端档位且保持固定计费模型", async () => {
    const imageProject = { createTask: jest.fn().mockResolvedValue(makeTaskRecord(9004, 1)) }
    const { generate, gateway } = await makeServices({ imageProject })
    jest.spyOn(gateway, "fetchModelSnapshot").mockResolvedValue({
      detail: { modality: "image" },
      requestSchema: { request_schema: { type: "object", properties: {
        aspect_ratio: { enum: ["3:2"] }, resolution: { enum: ["4k"] },
      } } },
    } as never)
    await mockLocalReferences()
    await expect(generate.create({ form: makeCreationForm({
      editMode: "local-redraw", provider: "ZQ-Image-3", resolutionTier: "1K",
      prompt: "移动文字", count: 1,
      mainImageUrls: ["https://cdn.example/original.png", "https://cdn.example/annotated.png"],
    }) }, 7)).resolves.toMatchObject({ ok: true, localRedraw: {
      provider: "ZQ-Image-2", providerApplied: { aspect_ratio: "3000:2000", resolution: "4k" },
    } })
    expect(imageProject.createTask.mock.calls[0][4].executionSpec).toMatchObject({
      provider: "ZQ-Image-2", form: { resolutionTier: "4K" },
      localRedraw: { sourceWidth: 3000, sourceHeight: 2000, providerApplied: { aspect_ratio: "3000:2000", resolution: "4k" } },
    })
  })

  it.each(["off", "on"])(
    "局部重绘在 structured=%s 时原样传递完整编辑指令且不注入模板",
    async flag => {
      const previousFlag = process.env.IMAGE_PROMPT_STRUCTURED
      process.env.IMAGE_PROMPT_STRUCTURED = flag
      try {
        const prisma = mockPrisma()
        const imageProject = { createTask: jest.fn().mockResolvedValue(makeTaskRecord(9004, 1)) }
        const { generate, usage } = await makeServices({ prisma, imageProject })
        const billing = Object.assign(usage, { gatewayFixedImageCredits: jest.fn().mockResolvedValue(new Decimal(10)), assertExactCreditsAffordable: jest.fn() })
        await mockLocalReferences()
        const prompt = "只修改框1内的字体颜色，保留英文原文，框外保持不变。".repeat(30)
        const mainImageUrls = [
          "https://cdn.example/original.png",
          "https://cdn.example/annotated.png",
        ]
        const result = await generate.create(
          {
            form: makeCreationForm({
              editMode: "local-redraw",
              provider: "ZQ-Image-3",
              prompt,
              count: 1,
              mainImageUrls,
              market: "amazon_mx",
              targetLanguage: undefined,
              textDensity: "none",
              brandIdentity: { logoUrl: "https://cdn.example/logo.png" },
            }),
          },
          7,
          "vidflowos",
          expect.objectContaining({ executionSpec: expect.objectContaining({ localRedraw: expect.any(Object) }) })
        )
        expect(result.ok).toBe(true)
        const spec = imageProject.createTask.mock.calls[0][4].executionSpec as GenerationExecutionSpec
        expect(prisma.generationTask.update).not.toHaveBeenCalled()
        expect(billing.gatewayFixedImageCredits).toHaveBeenCalledWith("ZQ-Image-2", "LOCAL_REDRAW")
        expect(billing.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal(10))
        expect(spec.provider).toBe("ZQ-Image-2")
        expect(spec.localRedraw).toEqual({ provider: "ZQ-Image-2", sourceWidth: 3000, sourceHeight: 2000, generationWidth: 4096, generationHeight: 2731, resolutionTier: "4K", providerApplied: { aspect_ratio: "3000:2000", resolution: "4k" } })
        expect(spec.deliveryPlan).toBeUndefined()
        expect(spec.taskPrompt).toBe(prompt)
        expect(spec.referenceUrls).toEqual(mainImageUrls)
        expect(spec.brandLogoAppended).toBe(false)
        expect(imageProject.createTask).toHaveBeenCalledWith(
          5,
          expect.objectContaining({ prompt }),
          7,
          "vidflowos",
          expect.objectContaining({ executionSpec: expect.objectContaining({ localRedraw: expect.any(Object) }) })
        )
      } finally {
        if (previousFlag === undefined) delete process.env.IMAGE_PROMPT_STRUCTURED
        else process.env.IMAGE_PROMPT_STRUCTURED = previousFlag
      }
    }
  )

  it("未初始化重绘模型时明确报错，不创建任务或回退前端模型", async () => {
    const prisma = mockPrisma()
    prisma.aiGatewayModel.findFirst.mockResolvedValue(null)
    const imageProject = { createTask: jest.fn() }
    const { generate } = await makeServices({ prisma, imageProject })
    const result = await generate.create({ form: makeCreationForm({ editMode: "local-redraw", provider: undefined, aspectRatio: undefined,
      mainImageUrls: ["https://cdn.example/original.png", "https://cdn.example/annotated.png"] }) }, 7)
    expect(result).toMatchObject({ ok: false, status: 503, error: expect.stringContaining("局部重绘模型未就绪") })
    expect(imageProject.createTask).not.toHaveBeenCalled()
  })

  it("局部重绘保留 promptOverride 的编辑指令", async () => {
    await mockLocalReferences()
    const prisma = mockPrisma()
    const imageProject = { createTask: jest.fn().mockResolvedValue(makeTaskRecord(9004, 1)) }
    const { generate } = await makeServices({ prisma, imageProject })
    await generate.create(
      {
        form: makeCreationForm({
          editMode: "local-redraw",
          mainImageUrls: ["https://cdn.example/original.png", "https://cdn.example/annotated.png"],
          promptOverride: "只修改框1，保留原图文字",
          market: "amazon_mx",
        }),
      },
      7
    )
    const spec = imageProject.createTask.mock.calls[0][4].executionSpec as GenerationExecutionSpec
    expect(spec.taskPrompt).toBe("只修改框1，保留原图文字")
  })

  it.each([
    { editMode: "unknown" },
    { editMode: "local-redraw", mode: "product-image" },
    { editMode: "local-redraw", prompt: "   " },
    { editMode: "local-redraw", mainImageUrls: [] },
    { editMode: "local-redraw", mainImageUrls: ["https://cdn.example/original.png"] },
  ])("局部重绘拒绝无效模式、空指令或缺少参考图 %j", async over => {
    const { generate, imageProject, queue } = await makeServices()
    const result = await generate.create(
      {
        form: makeCreationForm({
          mainImageUrls: ["https://cdn.example/original.png", "https://cdn.example/annotated.png"],
          ...over,
        }),
      },
      7
    )
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(imageProject.createTask).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it("keeps the [...urlMains, ...fileMains, ...attachedRefs, logo] reference order", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord(9004, 1)),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    await generate.create(
      {
        form: makeCreationForm({
          count: 1,
          mainImageUrls: ["https://cdn.example/prev.png"],
          brandIdentity: { logoUrl: "https://cdn.example/logo.png" },
        }),
        files: {
          mainImages: [makeFile()],
          attachedRefs: [makeFile("attachedRefs")],
        },
      },
      7,
    );
    const spec = prisma.generationTask.update.mock.calls[0][0].data
      .executionSpec as GenerationExecutionSpec;
    expect(spec.referenceUrls).toEqual([
      "https://cdn.example/prev.png",
      fakePresign.publicUrl, // file main
      fakePresign.publicUrl, // attached ref
      "https://cdn.example/logo.png", // 服务端注入的 brand logo 槽
    ]);
    expect(spec.mainCount).toBe(2);
    expect(spec.paperclipAttachedCount).toBe(1);
    expect(spec.brandLogoAppended).toBe(true);
    // 任务 refImageUrls 只含文件型上传(照源:url 主图/logo 不重复归档)
    expect(imageProject.createTask.mock.calls[0][1].refImageUrls).toEqual([
      fakePresign.publicUrl,
      fakePresign.publicUrl,
    ]);
  });

  it("legacy product-image: retired slot (atlas-wan) rejected with the single form message (B4)", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord(9003, 2)),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    const files = {
      main: [makeFile("main")],
      detail: [makeFile("detail")],
    };
    const r = await generate.create({ form: makeLegacyForm({ provider: "atlas-wan" }), files }, 7);
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid or missing `form` field" });
    expect(imageProject.createTask).not.toHaveBeenCalled();
  });

  it("legacy product-image with gemini uses buildImagePrompt; promptOverride wins the archived prompt", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord(9005, 2)),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    await generate.create(
      {
        form: makeLegacyForm({ promptOverride: "LEGACY-OVERRIDE" }),
        files: { main: [makeFile("main")] },
      },
      7,
    );
    const spec = prisma.generationTask.update.mock.calls[0][0].data
      .executionSpec as GenerationExecutionSpec;
    const expected = buildImagePrompt({
      productName: "保温杯",
      categoryL1: "Home",
      categoryL2: "Kitchen",
      imageType: "scene",
      aspectRatio: "1:1",
      resolution: "1024x1024",
      hasDetailImage: false,
      hasStructureImage: false,
      targetLanguage: "zh",
    });
    expect(spec.taskPrompt).toBe("LEGACY-OVERRIDE");
    expect(imageProject.createTask.mock.calls[0][1].prompt).toBe("LEGACY-OVERRIDE");
    // 执行侧 legacy 仍走 builder(源 generateOne 不看 promptOverride)
    expect(expected.length).toBeGreaterThan(0);
  });

  it("forwards imageLabelBase in the createTask payload when set", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord(9006, 1)),
    };
    const { generate } = await makeServices({ prisma, imageProject });
    await generate.create(
      {
        form: makeCreationForm({ count: 1, imageLabelBase: "套图1" }),
        files: {},
      },
      7,
    );
    const dto = imageProject.createTask.mock.calls[0][1];
    expect(dto.imageLabelBase).toBe("套图1");
  });

  it("dispatches openai-gpt-image as a single sequential task (settleTasksSequentially parity)", async () => {
    const prisma = mockPrisma();
    const imageProject = {
      createTask: jest.fn().mockResolvedValue(makeTaskRecord(9007, 2)),
    };
    const { generate, queue } = await makeServices({ prisma, imageProject });
    await generate.create(
      {
        form: makeCreationForm({ provider: "openai-gpt-image" }),
        files: {},
      },
      7,
    );
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ─── 执行器 ─────────────────────────────────────────────────────────────────

function specFixture(over: Partial<GenerationExecutionSpec> = {}): GenerationExecutionSpec {
  return {
    kind: "IMAGE_CREATIVE_GENERATE",
    mode: "image-creation",
    provider: "atlas-gpt",
    taskPrompt: "COMPILED-PROMPT",
    promptResolution: "1024x1024",
    form: {
      productName: "保温杯",
      categoryL1: "Home",
      categoryL2: "Kitchen",
      aspectRatio: "1:1",
      resolutionTier: "1K",
      resolution: "1024x1024",
      targetLanguage: "zh",
      hasDetailImage: false,
      hasStructureImage: false,
    },
    items: [{ order: 0, typeKey: "custom:image-creation:0", imageType: "image-creation:0" }],
    referenceUrls: ["https://cdn.example/ref.png"],
    mainCount: 1,
    paperclipAttachedCount: 0,
    brandLogoAppended: false,
    ...over,
  };
}

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: 9001,
    userId: 7,
    status: "GENERATING",
    cancelRequested: false,
    deadlineAt: new Date(Date.now() + 10 * 60_000),
    executionSpec: specFixture(),
    generatedImages: [],
    ...over,
  };
}

describe("generation task runner", () => {
  it("网关原生支持时即使存在交付计划也托管原图，不执行 finalize", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany.mockResolvedValue({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10, order: 0, status: "GENERATING",
      task: taskRow({ executionSpec: specFixture({ referenceUrls: [], deliveryPlan: plan({
        targetWidth: 800, targetHeight: 600, resolutionTier: "1K",
      }) }) }),
    });
    prisma.generationTask.findUnique.mockResolvedValue(taskRow({ generatedImages: [{ status: "SUCCESS" }] }));
    const bytes = await sharp({ create: { width: 357, height: 211, channels: 3, background: "white" } }).png().toBuffer();
    const generate = jest.fn().mockResolvedValue({
      url: `data:image/png;base64,${bytes.toString("base64")}`,
      gatewayImage: { nativeSizing: true, width: 357, height: 211, originalUrl: "https://stored.example/original.png" },
    });
    const finalizeSpy = jest.spyOn(deliveryFinalize, "finalizeGeneratedImage");
    try {
      const { runner } = await makeServices({ prisma, provider: { generate } });
      const fetchStart = fetchMock.mock.calls.length;
      await runner.executeGeneratedImage(10);
      expect(finalizeSpy).not.toHaveBeenCalled();
      expect(prisma.generatedImage.updateMany.mock.calls[1][0].data).toMatchObject({
        status: "SUCCESS", url: fakePresign.publicUrl, width: 357, height: 211,
        originalUrl: "https://stored.example/original.png",
      });
      const put = fetchMock.mock.calls.slice(fetchStart).find(([, init]) => init?.method === "PUT");
      expect(Buffer.from(put![1].body)).toEqual(bytes);
    } finally {
      finalizeSpy.mockRestore();
    }
  });

  it("网关缺尺寸时读取最终托管文件宽高并落库，不使用请求尺寸", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany.mockResolvedValue({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10, order: 0, status: "GENERATING",
      task: taskRow({ executionSpec: specFixture({ referenceUrls: [] }) }),
    });
    prisma.generationTask.findUnique.mockResolvedValue(taskRow({ generatedImages: [{ status: "SUCCESS" }] }));
    const bytes = await sharp({ create: { width: 357, height: 211, channels: 3, background: "white" } }).png().toBuffer();
    const measuredResponse = { ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => bytes };
    fetchMock.mockResolvedValueOnce(measuredResponse).mockResolvedValueOnce(measuredResponse).mockResolvedValueOnce(measuredResponse);
    const url = "https://outputs.nyc3.digitaloceanspaces.com/final.png";
    const generate = jest.fn().mockResolvedValue({ url, gatewayImage: { modelPublicId: "ZQ-Image-1" } });
    const { runner } = await makeServices({ prisma, provider: { generate } });

    await runner.executeGeneratedImage(10);

    expect(prisma.generatedImage.updateMany.mock.calls[1][0].data).toMatchObject({
      status: "SUCCESS", url: fakePresign.publicUrl, width: 357, height: 211,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("executes one image: provider input from frozen spec, CAS settle, aggregate SUCCESS + usage", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // settle
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({ generatedImages: [{ status: "SUCCESS" }] }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      gatewayTaskId: "gw-task-9001-10",
      gatewayImage: {
        width: 819,
        height: 1024,
        adaptation: {
          requested: { aspect_ratio: "4:5", resolution: "1k" },
          actual: { size: "819x1024", aspect_ratio: "4:5", resolution: "1k" },
          changes: [],
        },
      },
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    // claim CAS:租约列 + attemptNo 递增
    const claim = prisma.generatedImage.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: 10, status: "GENERATING" });
    expect(claim.data.attemptNo).toEqual({ increment: 1 });

    // provider 输入:引用图 URL 拉回 base64、编译稿透传、authToken 空
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "COMPILED-PROMPT",
        referenceImages: [
          {
            mimeType: "image/png",
            base64: Buffer.from("refbytes").toString("base64"),
            url: "https://cdn.example/ref.png",
          },
        ],
        aspectRatio: "1:1",
        resolutionTier: "1K",
        authToken: "",
      }),
    );

    // settle CAS(WHERE status='GENERATING')+ 托管 URL
    const settle = prisma.generatedImage.updateMany.mock.calls[1][0];
    expect(settle.where).toEqual({ id: 10, status: "GENERATING" });
    expect(settle.data).toEqual({
      url: fakePresign.publicUrl,
      status: "SUCCESS",
      errorMessage: null,
      width: 819,
      height: 1024,
      nativeWidth: 819,
      nativeHeight: 1024,
      // 审计:图片行 ↔ 网关任务关联(2026-09-10 补齐)
      providerJobId: "gw-task-9001-10",
      deliveryMeta: {
        gatewayImage: {
          width: 819,
          height: 1024,
          adaptation: {
            requested: { aspect_ratio: "4:5", resolution: "1k" },
            actual: { size: "819x1024", aspect_ratio: "4:5", resolution: "1k" },
            changes: [],
          },
        },
      },
    });

    // 聚合:任一成功 → SUCCESS
    expect(prisma.generationTask.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 9001, status: "GENERATING" },
      data: { status: "SUCCESS", errorMessage: null },
    });

    // usage:仅成功图,source/meta 口径照源
    expect(usage.chargeTokens).toHaveBeenCalledTimes(1);
    expect(usage.chargeTokens).toHaveBeenCalledWith(
      7,
      {
        promptTokens: 3,
        completionTokens: 4,
        thinkingTokens: undefined,
        source: "aicreative.image_generate",
        meta: { taskId: 9001, provider: "atlas-gpt", imageCount: 1 },
      },
      { invokeType: "PLATFORM" }
    )
  });

  it("gateway amount flush 落任务级网关任务关联快照(1:1 时单值列同写,审计)", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // settle
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique
      .mockResolvedValueOnce(taskRow({ generatedImages: [{ status: "SUCCESS" }] })) // 聚合读
      .mockResolvedValueOnce({ gatewayTaskIds: null, gatewayTaskId: null }); // 关联读(合并基线)
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      costAmountCny: "0.75",
      gatewayTaskId: "gw-task-9001-10",
    });
    const usage = {
      chargeTokens: jest.fn(),
      chargeModel: jest.fn().mockResolvedValue(undefined),
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(3)),
    };
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
      usage: usage as never,
    });

    await runner.executeGeneratedImage(10);

    // flush 点:1 个网关任务 → gatewayTaskIds 数组 + 单值 gatewayTaskId 同写;
    // imageId/attemptNo 从幂等键 imggen:9001:10:0 回解
    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith({
      where: { id: 9001 },
      data: {
        gatewayTaskIds: [{ gatewayTaskId: "gw-task-9001-10", imageId: 10, attemptNo: 0 }],
        gatewayTaskId: "gw-task-9001-10",
      },
    });
  });

  it("legacy mode rebuilds the per-item prompt at execution (promptOverride not used, source parity)", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 1,
      status: "GENERATING",
      task: taskRow({
        executionSpec: specFixture({
          mode: "product-image",
          provider: "atlas-gpt",
          taskPrompt: "ARCHIVED-PROMPT",
          items: [
            { order: 0, typeKey: "scene", imageType: "scene" },
            { order: 1, typeKey: "custom:自定义卖点图", imageType: "自定义卖点图" },
          ],
        }),
      }),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({ generatedImages: [{ status: "SUCCESS" }] }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
    });
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    // atlas-wan 的 edit-prompt 分支随 B4 移除;legacy 一律 buildImagePrompt
    const expected = buildImagePrompt({
      productName: "保温杯",
      categoryL1: "Home",
      categoryL2: "Kitchen",
      imageType: "自定义卖点图", // order=1 → items[1]
      aspectRatio: "1:1",
      resolution: "1024x1024",
      targetLanguage: "zh",
    });
    expect(generate.mock.calls[0][0].prompt).toBe(expected);
  });

  it("marks the image FAILED with describeImageError message; all-failed → CANCELLED 所有图片生成失败; no usage", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({
        generatedImages: [
          { status: "FAILED", errorMessage: "x" },
          { status: "FAILED", errorMessage: "y" },
        ],
      }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockRejectedValue(new Error("provider call failed"));
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    const failCall = prisma.generatedImage.updateMany.mock.calls[1][0];
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("provider call failed");
    expect(prisma.generationTask.updateMany.mock.calls[0][0].data).toEqual({
      status: "CANCELLED",
      errorMessage: "所有图片生成失败",
    });
    expect(usage.chargeTokens).not.toHaveBeenCalled();
  });

  it("partial success: task SUCCESS and usage counts only the succeeded image", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({
        generatedImages: [{ status: "SUCCESS" }, { status: "FAILED", errorMessage: "x" }],
      }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    expect(prisma.generationTask.updateMany.mock.calls[0][0].data.status).toBe("SUCCESS");
    expect(usage.chargeTokens).toHaveBeenCalledTimes(1);
    expect(usage.chargeTokens.mock.calls[0][1].meta).toEqual({
      taskId: 9001,
      provider: "atlas-gpt",
      imageCount: 1,
    });
  });

  it("skips usage report when provider returns zero token usage (source parity)", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({ generatedImages: [{ status: "SUCCESS" }] }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    expect(prisma.generationTask.updateMany.mock.calls[0][0].data.status).toBe("SUCCESS");
    expect(usage.chargeTokens).not.toHaveBeenCalled();
  });

  it("degrades to hosting the raw image when finalize fails (never loses a billed image)", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow({
        executionSpec: specFixture({
          deliveryPlan: plan({
            targetWidth: 800,
            targetHeight: 600,
            resolutionTier: "1K",
          }),
        }),
      }),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({ generatedImages: [{ status: "SUCCESS" }] }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    // data URL 携带非法图片字节 → finalize(Sharp)必败 → 走降级托管
    const generate = jest
      .fn()
      .mockResolvedValue({ url: "data:image/png;base64,AA==" });
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    const input = generate.mock.calls[0][0];
    // 交付计划工作尺寸已下发(800×600 @1K → 长边 1024)
    expect(input.workingWidth).toBe(1024);
    expect(input.workingHeight).toBe(768);
    const settle = prisma.generatedImage.updateMany.mock.calls[1][0];
    expect(settle.data.status).toBe("SUCCESS");
    expect(settle.data.url).toBe(fakePresign.publicUrl); // 降级托管 raw 图
  });

  it("silently skips when the CAS claim fails (cancelled/terminal/lease held)", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany.mockResolvedValueOnce({ count: 0 });
    const generate = jest.fn();
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    expect(prisma.generatedImage.findUnique).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("bails without provider call when the task was cancelled before load", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany.mockResolvedValue({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow({ status: "CANCELLED", cancelRequested: true }),
    });
    const generate = jest.fn();
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    expect(generate).not.toHaveBeenCalled();
    expect(prisma.generatedImage.updateMany.mock.calls[1][0].data).toEqual({
      status: "FAILED",
      errorMessage: "已手动取消",
    });
  });

  it("converges an image past deadline and aggregates the task to TIMEOUT", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany.mockResolvedValue({ count: 1 });
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow({ deadlineAt: new Date(Date.now() - 1_000) }),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({
        deadlineAt: new Date(Date.now() - 1_000),
        generatedImages: [{ status: "FAILED" }],
      }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });
    const generate = jest.fn();
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    expect(generate).not.toHaveBeenCalled();
    expect(prisma.generatedImage.updateMany.mock.calls[1][0].data).toEqual({
      status: "FAILED",
      errorMessage: "任务超过 10 分钟，已自动结束",
    });
    expect(prisma.generationTask.updateMany.mock.calls[0][0].data).toEqual({
      status: "TIMEOUT",
      errorMessage: "任务超过 10 分钟，已自动结束",
    });
  });
});

// ─── 取消(竞态修复)─────────────────────────────────────────────────────────

describe("generate cancel (race-fixed)", () => {
  it("does not cancel or abort an internal task through the public endpoint", async () => {
    const prisma = mockPrisma()
    prisma.generationTask.findUnique.mockResolvedValue(null)
    const { generate, runner } = await makeServices({ prisma })
    const abort = jest.spyOn(runner, "onTaskCancelled")
    expect(await generate.cancel(9001, 7)).toEqual({ success: true, aborted: false })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it("cancels task + images in one transaction with the Next-identical message", async () => {
    const prisma = mockPrisma();
    prisma.generationTask.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.generatedImage.updateMany.mockResolvedValueOnce({ count: 2 });
    prisma.generationTask.findUnique.mockResolvedValueOnce(taskRow({ status: "CANCELLED" }));
    const { generate } = await makeServices({ prisma });

    const r = await generate.cancel(9001, 7);

    expect(r).toEqual({ success: true, aborted: false });
    expect(prisma.generationTask.updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: 9001,
        status: "GENERATING",
        userId: 7,
        source: "platform",
        project: { source: "platform" },
      },
      data: {
        status: "CANCELLED",
        errorMessage: "已手动取消",
        cancelRequested: true,
      },
    });
    expect(prisma.generatedImage.updateMany.mock.calls[0][0]).toEqual({
      where: { taskId: 9001, status: "GENERATING" },
      data: { status: "FAILED", errorMessage: "已手动取消" },
    });
  });

  it("is idempotent: terminal task → no image writes, still success", async () => {
    const prisma = mockPrisma();
    prisma.generationTask.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.generationTask.findUnique.mockResolvedValueOnce(taskRow({ status: "CANCELLED" }));
    const { generate } = await makeServices({ prisma });

    const r = await generate.cancel(9001, 7);

    expect(r).toEqual({ success: true, aborted: false });
    expect(prisma.generatedImage.updateMany).not.toHaveBeenCalled();
  });

  it("late success after cancel is discarded by the settle CAS and its usage is not billed", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim(取消前)
      .mockResolvedValueOnce({ count: 0 }); // settle CAS 被取消挡掉
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({
        status: "CANCELLED",
        generatedImages: [{ status: "FAILED", errorMessage: "已手动取消" }],
      }),
    );
    const generate = jest.fn().mockResolvedValue({
      url: "data:image/png;base64,AA==",
      tokenUsage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
    });
    const { runner, usage } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    await runner.executeGeneratedImage(10);

    // settle 仍发,但带 GENERATING 前置条件(CAS)——取消后 count=0 被丢弃
    const settle = prisma.generatedImage.updateMany.mock.calls[1][0];
    expect(settle.where).toEqual({ id: 10, status: "GENERATING" });
    // 晚到成功的 usage 不计费
    expect(usage.chargeTokens).not.toHaveBeenCalled();
    // 已取消的任务终态不被聚合改写
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it("aborts an in-flight provider call via the cancel registry", async () => {
    const prisma = mockPrisma();
    prisma.generatedImage.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValue({ count: 0 }); // 后续 settle 全被挡
    prisma.generatedImage.findUnique.mockResolvedValue({
      id: 10,
      order: 0,
      status: "GENERATING",
      task: taskRow(),
    });
    prisma.generationTask.findUnique.mockResolvedValue(
      taskRow({ generatedImages: [{ status: "FAILED" }] }),
    );
    prisma.generationTask.updateMany.mockResolvedValue({ count: 1 });

    let releaseProvider!: (v: { url: string }) => void;
    const generate = jest.fn(
      () =>
        new Promise<{ url: string }>((resolve) => {
          releaseProvider = resolve;
        }),
    );
    const { runner } = await makeServices({
      prisma,
      provider: { generate } as Partial<ImageProvider>,
    });

    const executing = runner.executeGeneratedImage(10);
    await untilCalled(generate); // provider 在途,AbortController 已注册

    const aborted = runner.abortTaskExecutions(9001);
    expect(aborted).toBe(true);
    expect((generate.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);

    releaseProvider({ url: "data:image/png;base64,AA==" }); // 晚到成功
    await executing;

    const settle = prisma.generatedImage.updateMany.mock.calls[1][0];
    expect(settle.where).toEqual({ id: 10, status: "GENERATING" });
  });
});

// ─── 对账扩展 ───────────────────────────────────────────────────────────────

describe("generate server-side retry (refresh-safe)", () => {
  const failedImages = [
    { id: 11, order: 0, status: "FAILED", errorMessage: "boom" },
    { id: 12, order: 1, status: "SUCCESS", errorMessage: null },
  ];

  it("retries all FAILED images from the frozen spec: resets images + task, extends deadline, re-dispatches", async () => {
    const prisma = mockPrisma();
    prisma.generationTask.findUnique.mockResolvedValueOnce(
      taskRow({
        status: "CANCELLED",
        errorMessage: "所有图片生成失败",
        generatedImages: failedImages,
      }),
    );
    const { generate, queue } = await makeServices({ prisma });

    const r = await generate.retryTaskImages(9001, 7);

    expect(r).toEqual({
      ok: true,
      generatedImages: [{ id: 11, order: 0, status: "GENERATING" }],
    });
    // 图:FAILED→GENERATING,计数/租约清零(认领 CAS 才能吃进)。
    expect(prisma.generatedImage.updateMany.mock.calls[0][0]).toEqual({
      where: { taskId: 9001, status: "FAILED" },
      data: {
        status: "GENERATING",
        errorMessage: null,
        attemptNo: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    // 任务:回 GENERATING + 延长 deadline(否则认领即超时)。
    const taskUpdate = prisma.generationTask.update.mock.calls[0][0];
    expect(taskUpdate.where).toEqual({ id: 9001 });
    expect(taskUpdate.data.status).toBe("GENERATING");
    expect(taskUpdate.data.errorMessage).toBeNull();
    expect(taskUpdate.data.deadlineAt.getTime()).toBeGreaterThan(Date.now());
    // 派发:非 openai-gpt-image → 每图一个任务。
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("chains sequential dispatch for openai-gpt-image (source parity)", async () => {
    const prisma = mockPrisma();
    prisma.generationTask.findUnique.mockResolvedValueOnce(
      taskRow({
        executionSpec: specFixture({ provider: "openai-gpt-image" }),
        generatedImages: [
          { id: 11, order: 0, status: "FAILED", errorMessage: "x" },
          { id: 12, order: 1, status: "FAILED", errorMessage: "y" },
        ],
      }),
    );
    const { generate, queue } = await makeServices({ prisma });
    const r = await generate.retryTaskImages(9001, 7);
    expect(r.ok).toBe(true);
    expect(queue.enqueue).toHaveBeenCalledTimes(1); // 串行:一个任务跑完两张
    if (r.ok) expect(r.generatedImages).toHaveLength(2);
  });

  it("404s for missing or foreign tasks", async () => {
    const prisma = mockPrisma();
    prisma.generationTask.findUnique.mockResolvedValueOnce(null);
    const { generate } = await makeServices({ prisma });
    expect(await generate.retryTaskImages(9001, 7)).toEqual({
      ok: false,
      status: 404,
      error: "任务不存在",
    });

    prisma.generationTask.findUnique.mockResolvedValueOnce(taskRow({ userId: 99 }));
    expect(await generate.retryTaskImages(9001, 7)).toEqual({
      ok: false,
      status: 404,
      error: "任务不存在",
    });
  });

  it("rejects user-cancelled tasks and tasks with no failed images", async () => {
    const prisma = mockPrisma();
    prisma.generationTask.findUnique.mockResolvedValueOnce(
      taskRow({ status: "CANCELLED", cancelRequested: true }),
    );
    const { generate } = await makeServices({ prisma });
    expect(await generate.retryTaskImages(9001, 7)).toEqual({
      ok: false,
      status: 400,
      error: "任务已手动取消，无法重试，请重新发起",
    });

    prisma.generationTask.findUnique.mockResolvedValueOnce(
      taskRow({
        status: "SUCCESS",
        generatedImages: [{ id: 12, order: 1, status: "SUCCESS" }],
      }),
    );
    expect(await generate.retryTaskImages(9001, 7)).toEqual({
      ok: false,
      status: 400,
      error: "没有可重试的失败图片",
    });
  });
});

describe("reconciliation (generate extension)", () => {
  it("requeues lease-expired GENERATING images and converges past-deadline tasks to TIMEOUT", async () => {
    const prisma = mockPrisma();
    prisma.imageGenItem.findMany.mockResolvedValue([]); // t2i/i2i 路径静默
    prisma.imageGenJob.findMany.mockResolvedValue([]);
    prisma.imageGenJob.deleteMany.mockResolvedValue({ count: 0 });
    prisma.generatedImage.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    prisma.generationTask.findMany.mockResolvedValue([{ id: 9001 }]);

    const queue = { enqueue: jest.fn() };
    const { runner } = await makeServices({ prisma });
    const recon = new ReconciliationService(
      prisma as unknown as PrismaService,
      queue as unknown as DispatchQueueService,
      { maxAttempts: 3 } as unknown as ImageGenItemRunnerService,
      runner,
    );

    await recon.reconcile();

    // 租约过期的 GENERATING 图重投(任务仍 GENERATING 才有意义)
    expect(prisma.generatedImage.findMany.mock.calls[0][0].where).toMatchObject({
      status: "GENERATING",
      task: { status: "GENERATING" },
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(2);

    // 超 deadlineAt 收敛:图 FAILED + 任务 TIMEOUT,errorMessage 照源超时语义
    expect(prisma.generatedImage.updateMany.mock.calls[0][0]).toEqual({
      where: { taskId: 9001, status: "GENERATING" },
      data: { status: "FAILED", errorMessage: "任务超过 10 分钟，已自动结束" },
    });
    expect(prisma.generationTask.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 9001, status: "GENERATING" },
      data: { status: "TIMEOUT", errorMessage: "任务超过 10 分钟，已自动结束" },
    });
  });
});

// 本文件只验证业务执行；真实文件标识由aigc/image-label.spec.ts覆盖。
jest.mock("../aigc/image-label", () => ({ labelImage: jest.fn((buffer: Buffer) => Promise.resolve({ buffer, mime: "image/png" })) }))
