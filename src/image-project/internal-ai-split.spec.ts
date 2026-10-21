import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common"
import { Test } from "@nestjs/testing"
import type { Server } from "node:http"
import httpRequest from "supertest"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { AiSplitService } from "./ai-split.service"
import { AiSplitValidator } from "./ai-split.validator"
import {
  InternalCreateAiSplitTaskDto,
  type InternalAiSplitProductSnapshotDto,
} from "./internal-ai-split.dto"
import { InternalImageGenerationController } from "./internal-image-generation.controller"
import { InternalImageGenerationService } from "./internal-image-generation.service"

const pipe = new ValidationPipe({ whitelist: true, transform: true })

const gateway = {
  fetchModelSnapshot: jest.fn().mockResolvedValue({
    detail: { modality: "image", facts: {} },
    requestSchema: { request_schema: { type: "object", properties: {} } },
  }),
}

const productSnapshot: InternalAiSplitProductSnapshotDto = {
  currentProduct: {
    productName: "HIBREW H10",
    attributes: [{ key: "Output Pressure", value: "20 bar" }],
    sellingPoints: ["一键泄压"],
    brandIdentity: { primaryColors: ["#C0C0C0"] },
  },
  productImages: [{ url: "https://cdn.example.com/main.jpg", purpose: "PRODUCT_MAIN" }],
}

function input(): InternalCreateAiSplitTaskDto {
  return {
    phone: "13800000000",
    request: {
      clientRequestId: "5af2b2ff-5a87-4182-943f-db197a04ea77",
      competitorReferences: [{ sourceType: "DIRECT_URL", url: "https://cdn.example.com/ref.jpg" }],
      site: "tiktok_us",
      textAmount: "LOW",
      model: "ZQ-Image-1",
      quantity: 1,
      promptConfig: { model_params: { quality: "standard" } },
      productSnapshot: structuredClone(productSnapshot),
    },
  }
}

function validatorSetup() {
  const project = {
    id: 31,
    name: "VidFlowOS 拆图创作",
    userId: 7,
    type: "ECOMMERCE",
    status: "ACTIVE",
    productProfile: null,
    productImages: [],
  }
  const prisma = { imageProject: { findUnique: jest.fn().mockResolvedValue(project) } }
  return { project, validator: new AiSplitValidator(prisma as never, {} as never, gateway as never) }
}

describe("VidFlowOS 内部拆图快照", () => {
  it("内部 DTO 保留任务商品快照，缺失快照或非法产品图返回 400", async () => {
    await expect(
      pipe.transform(input(), { type: "body", metatype: InternalCreateAiSplitTaskDto })
    ).resolves.toEqual(input())
    for (const snapshot of [
      undefined,
      [],
      { ...productSnapshot, productImages: [] },
      { ...productSnapshot, productImages: [[]] },
    ]) {
      const dto = input()
      await expect(
        pipe.transform(
          { ...dto, request: { ...dto.request, productSnapshot: snapshot } },
          {
            type: "body",
            metatype: InternalCreateAiSplitTaskDto,
          }
        )
      ).rejects.toBeInstanceOf(BadRequestException)
    }
  })

  it("内部请求和模型配置必须是对象", async () => {
    const dto = input()
    for (const request of [
      [],
      { ...dto.request, promptConfig: undefined },
      { ...dto.request, promptConfig: [] },
    ]) {
      await expect(
        pipe.transform(
          { ...dto, request },
          { type: "body", metatype: InternalCreateAiSplitTaskDto }
        )
      ).rejects.toBeInstanceOf(BadRequestException)
    }
  })

  it("容器项目没有资料也能使用请求快照，属性规范化且保留品牌", async () => {
    const { validator } = validatorSetup()
    const snapshot = await validator.buildProjectSnapshot(31, 7, "tiktok_us", productSnapshot)
    expect(snapshot).toMatchObject({
      currentProduct: {
        productName: "HIBREW H10",
        attributes: { Output_Pressure: "20 bar" },
        brandIdentity: { primaryColors: ["#C0C0C0"] },
        sellingPoints: ["一键泄压"],
      },
      productImages: [
        { url: "https://cdn.example.com/main.jpg", purpose: "PRODUCT_MAIN", index: 1 },
      ],
      locale: "en-US",
      language: "English (en-US)",
    })
    expect(snapshot.currentProductKeys).toContain("attributes.Output_Pressure")
  })

  it("源平台自己的调用没有快照时仍要求项目商品资料", async () => {
    const { validator } = validatorSetup()
    await expect(validator.buildProjectSnapshot(31, 7, "tiktok_us")).rejects.toThrow(
      "请先完善当前 SKU 商品资料"
    )
  })

  it("不同 SKU 并发读取同一容器时，资料和产品图不会串用", async () => {
    const { validator, project } = validatorSetup()
    const second = {
      currentProduct: { productName: "商品 B" },
      productImages: [{ url: "https://cdn.example.com/b.jpg", purpose: "PRODUCT_MAIN" }],
    }
    const results = await Promise.all([
      validator.buildProjectSnapshot(31, 7, "tiktok_us", productSnapshot),
      validator.buildProjectSnapshot(31, 7, "tiktok_mx", second),
    ])
    expect(results.map(snapshot => snapshot.currentProduct.productName)).toEqual([
      "HIBREW H10",
      "商品 B",
    ])
    expect(results[1].productImages[0].url).toBe("https://cdn.example.com/b.jpg")
    expect(results[1].language).toBe("Spanish (es-MX)")
    expect(project.productProfile).toBeNull()
    expect(project.productImages).toEqual([])
    expect(productSnapshot.currentProduct.attributes).toEqual([
      { key: "Output Pressure", value: "20 bar" },
    ])
  })

  it("请求快照不能绕过容器项目归属校验", async () => {
    const { validator } = validatorSetup()
    await expect(
      validator.buildProjectSnapshot(31, 8, "tiktok_us", productSnapshot)
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it.each([
    { ...productSnapshot, currentProduct: { productName: " " } },
    {
      ...productSnapshot,
      productImages: [{ url: "https://cdn.example.com/detail.jpg", purpose: "PRODUCT_DETAIL" }],
    },
    {
      ...productSnapshot,
      productImages: [
        ...productSnapshot.productImages,
        { url: "https://cdn.example.com/box.jpg", purpose: "PACKAGING" },
      ],
    },
    {
      ...productSnapshot,
      productImages: [
        {
          url: "[https://cdn.example.com/main.jpg](https://cdn.example.com/main.jpg)",
          purpose: "PRODUCT_MAIN",
        },
      ],
    },
  ])("拒绝无名称、无主图、无用途说明或非法 URL 的快照 %#", async snapshot => {
    const { validator } = validatorSetup()
    await expect(
      validator.buildProjectSnapshot(31, 7, "tiktok_us", snapshot)
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("内部代理把快照和来源传入拆图服务，创建后不再补标记", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
      imageProject: { findFirst: jest.fn().mockResolvedValue({ id: 31 }) },
      generationTask: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      generatedImage: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    }
    const aiSplit = {
      createTasks: jest.fn().mockResolvedValue({ tasks: [{ id: 90 }, { id: 91 }] }),
    }
    const service = new InternalImageGenerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      aiSplit as never
    )
    const dto = input()
    await service.createAiSplitTasks(dto)
    expect(aiSplit.createTasks).toHaveBeenCalledWith(
      31,
      dto.request,
      7,
      dto.request.productSnapshot,
      "vidflowos"
    )
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled()
    expect(prisma.generatedImage.updateMany).not.toHaveBeenCalled()
  })

  it("内部代理拒绝跨系统素材 ID，源平台不查素材或创建任务", async () => {
    const aiSplit = { createTasks: jest.fn() }
    const prisma = { user: { findUnique: jest.fn() } }
    const service = new InternalImageGenerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      aiSplit as never
    )
    const dto = input()
    dto.request.competitorReferences = [{ sourceType: "COMPETITOR_DATA", sourceId: 12 }]
    await expect(service.createAiSplitTasks(dto)).rejects.toThrow("本地素材 ID 不能跨系统查询")
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(aiSplit.createTasks).not.toHaveBeenCalled()
  })

  it("拆图任务持久化本次商品快照，Runner 无需再次读取 SKU 资料", async () => {
    const { validator } = validatorSetup()
    jest.spyOn(validator, "loadAnalysisModel").mockResolvedValue({
      id: 1,
      publicId: "analysis",
      displayName: "分析模型",
      gatewayConfig: {},
    })
    jest
      .spyOn(validator, "resolveCompetitorReferences")
      .mockResolvedValue([{ sourceType: "DIRECT_URL", url: "https://cdn.example.com/ref.jpg" }])
    jest.spyOn(validator, "validateImageModel").mockResolvedValue({
      id: 2,
      publicId: "ZQ-Image-1",
      displayName: "图片模型",
      gatewayConfig: {},
      modelParams: { quality: "standard" },
      supportsNegativePrompt: false,
    })
    const snapshots: unknown[] = []
    const tx = {
      generationTask: {
        create: jest.fn((args: { data: { promptConfig: unknown } }) => {
          snapshots.push(args.data.promptConfig)
          return Promise.resolve({ id: 90 })
        }),
      },
      imageProject: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = {
      generationTask: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const runner = {
      getPromptVersions: jest
        .fn()
        .mockReturnValue({ competitorAnalysis: "v3", productImageGeneration: "v4" }),
      run: jest.fn().mockResolvedValue(undefined),
    }
    const service = new AiSplitService(
      prisma as never,
      validator,
      runner as never,
      {} as never,
      { gatewayFixedImageCredits: jest.fn().mockResolvedValue(null) } as never,
      {} as never
    )
    jest.spyOn(service, "getTaskGroup").mockResolvedValue({ tasks: [{ id: 90 }] } as never)
    const dto = input().request
    await service.createTasks(31, dto, 7, dto.productSnapshot, "vidflowos")
    expect(tx.generationTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "vidflowos",
          generatedImages: { create: [{ source: "vidflowos", status: "GENERATING", order: 0 }] },
        }),
      })
    )
    expect(snapshots).toMatchObject([
      {
        currentProduct: { productName: "HIBREW H10", attributes: { Output_Pressure: "20 bar" } },
        currentProductKeys: expect.arrayContaining([
          "productName",
          "attributes.Output_Pressure",
        ]) as unknown,
        productImages: [{ url: "https://cdn.example.com/main.jpg", purpose: "PRODUCT_MAIN" }],
      },
    ])
    expect(runner.run).toHaveBeenCalledWith(90)
  })
})

describe("内部拆图 HTTP 快照契约", () => {
  let app: INestApplication<Server>
  const createAiSplitTasks = jest.fn().mockResolvedValue({ tasks: [{ id: 90 }] })
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InternalImageGenerationController],
      providers: [{ provide: InternalImageGenerationService, useValue: { createAiSplitTasks } }],
    })
      .overrideGuard(InternalGenerationGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.listen(0, "127.0.0.1")
  })
  beforeEach(() => jest.clearAllMocks())
  afterAll(async () => {
    await app?.close()
  })

  it("内部入口完整保留 currentProduct 属性与产品图用途", async () => {
    await httpRequest(app.getHttpServer())
      .post("/internal/generation/image/ai-split-tasks")
      .send(input())
      .expect(201)
    expect(createAiSplitTasks).toHaveBeenCalledWith(input())
  })

  it("VidFlow 原样携带冲突旧尺寸时，交付目标和请求一起透传到共用校验器", async () => {
    const dto = input()
    dto.request.model = "ZQ-Image-Ultra"
    dto.request.deliveryTarget = { aspectRatio: "463:625", resolutionTier: "2K" }
    dto.request.promptConfig.model_params = {
      aspect_ratio: "463:625", size: "1728x2304", quality: "standard", output_format: "png",
    }
    await httpRequest(app.getHttpServer())
      .post("/internal/generation/image/ai-split-tasks")
      .send(dto)
      .expect(201)
    expect(createAiSplitTasks).toHaveBeenCalledWith(dto)
  })

  it("缺失商品快照的旧请求在服务调用前返回 400", async () => {
    const dto = input()
    await httpRequest(app.getHttpServer())
      .post("/internal/generation/image/ai-split-tasks")
      .send({ ...dto, request: { ...dto.request, productSnapshot: undefined } })
      .expect(400)
    expect(createAiSplitTasks).not.toHaveBeenCalled()
  })
})
