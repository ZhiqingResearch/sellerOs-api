import { ChetaidouImageOptionsService } from "./chetaidou-image-options.service"
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// 车泰斗素材工作台 — C 端服务核心路径单测（mock Prisma，仓库惯例）
// 覆盖：任务幂等（同键同/异内容）、草稿 CAS、上传落库失败补偿。
import { ConflictException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { ChetaidouStorageService } from "./chetaidou-storage.service"
import { ChetaidouService } from "./chetaidou.service"

describe("ChetaidouService", () => {
  let service: ChetaidouService
  let mockPrisma: Record<string, jest.Mock>

  beforeEach(async () => {
    mockPrisma = {
      chetaidouSku: { findUnique: jest.fn() },
      chetaidouFactCard: { findUnique: jest.fn() },
      chetaidouImage: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      chetaidouBreakdown: { findUnique: jest.fn(), count: jest.fn(), create: jest.fn() },
      chetaidouDraft: { findUnique: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
      chetaidouTask: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      chetaidouGroup: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      chetaidouCall: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      imageGenJob: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      imageGenItem: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouService,
        {
          provide: ChetaidouImageOptionsService,
          useValue: {
            resolveModel: jest.fn().mockResolvedValue({
              publicId: "image",
              gatewayConfig: {
                requestSchema: { version: 1, request_schema: { type: "object", properties: {} } },
              },
            }),
            assertUnchanged: jest.fn(),
          },
        },
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ChetaidouContextService,
          useValue: {
            resolveBreakdownModels: jest.fn().mockResolvedValue({
              text: { publicId: "qwen3.8-max", category: "CHETAIDOU_BREAKDOWN" },
              image: { publicId: "image", category: "CHETAIDOU_IMAGE" },
            }),
            buildSnapshot: jest.fn(() => ({})),
            contextHash: jest.fn(() => "hash"),
            requestHash: jest.fn(() => "reqhash"),
            loadCurrentContext: jest.fn(),
          },
        },
        {
          provide: ChetaidouStorageService,
          useValue: {
            validateImage: jest.fn(),
            signDownload: jest.fn().mockResolvedValue("https://signed"),
            uploadMaster: jest.fn(),
            deleteObject: jest.fn(),
            masterFileKey: jest.fn(() => "chetaidou/1/preset/x/master.png"),
          },
        },
        {
          provide: ChetaidouBillingService,
          useValue: {
            assertModelsReady: jest.fn(),
          },
        },
      ],
    }).compile()
    service = moduleRef.get(ChetaidouService)
  })

  it("配置保留原有字段，不下发生图控件或额外解析模型参数", async () => {
    jest.spyOn(service["billing"], "assertModelsReady").mockResolvedValue({
      text: { publicId: "text", category: "CHETAIDOU_MULTIMODAL" },
      image: { publicId: "image", category: "CHETAIDOU_IMAGE" },
    })
    const resolveImageModel = jest.spyOn(service["imageOptions"], "resolveModel")
    const config = await service.getConfig()
    expect(config).toMatchObject({ generateCounts: [1, 2, 4, 8], models: { ready: true } })
    expect(service["context"].resolveBreakdownModels).toHaveBeenCalled()
    expect(config).not.toHaveProperty("imageGeneration")
    expect(resolveImageModel).not.toHaveBeenCalled()
  })

  it("非 GENERATE 不接受生图比例/尺寸字段", async () => {
    await expect(
      service.createTask(7, {
        type: "IDEATION",
        imageId: 19,
        idempotencyKey: "wrong-type",
        aspectRatio: "16:9",
      })
    ).rejects.toThrow("仅可用于 GENERATE")
    expect(mockPrisma.chetaidouTask.findFirst).not.toHaveBeenCalled()
  })

  it("没有历史任务也返回全部站点及当前 SKU 可见母版", async () => {
    mockPrisma.chetaidouSku.findUnique.mockResolvedValue({ id: 1, enabled: true })
    mockPrisma.chetaidouTask.findMany.mockResolvedValue([])
    const images = [
      {
        id: 19,
        skuId: 1,
        enabled: true,
        sourceType: "PRESET",
        ownerId: null,
        title: "预置",
        number: "NO19",
      },
      {
        id: 20,
        skuId: 1,
        enabled: true,
        sourceType: "USER_UPLOAD",
        ownerId: 7,
        title: "本人上传",
        number: "NO20",
      },
      {
        id: 21,
        skuId: 1,
        enabled: true,
        sourceType: "USER_UPLOAD",
        ownerId: 8,
        title: "他人上传",
        number: "NO21",
      },
      {
        id: 22,
        skuId: 1,
        enabled: false,
        sourceType: "PRESET",
        ownerId: null,
        title: "停用",
        number: "NO22",
      },
      {
        id: 23,
        skuId: 2,
        enabled: true,
        sourceType: "PRESET",
        ownerId: null,
        title: "其他 SKU",
        number: "NO23",
      },
    ]
    mockPrisma.chetaidouImage.findMany.mockImplementation(({ where }) =>
      images
        .filter(
          image =>
            image.skuId === where.skuId &&
            image.enabled === where.enabled &&
            where.OR.some(
              condition =>
                image.sourceType === condition.sourceType &&
                (condition.ownerId === undefined || image.ownerId === condition.ownerId)
            )
        )
        .map(({ id, title, number }) => ({ id, title, number }))
    )
    const options = await service.filterOptions(7, 1)
    expect(options.sites).toEqual([
      "original",
      "amazon_us",
      "amazon_de",
      "amazon_fr",
      "amazon_es",
      "amazon_it",
      "amazon_jp",
    ])
    expect(options.images).toEqual([
      { id: 19, title: "预置", number: "NO19" },
      { id: 20, title: "本人上传", number: "NO20" },
    ])
    expect(mockPrisma.chetaidouTask.findMany).not.toHaveBeenCalled()
  })

  describe("createTask 幂等", () => {
    it("同键同内容返回原任务", async () => {
      mockPrisma.chetaidouTask.findFirst.mockResolvedValue({
        id: "task-1",
        requestHash: "reqhash",
        type: "IDEATION",
        rootTaskId: "task-1",
        ownerId: 1,
        imageGenJobId: null,
      })
      mockPrisma.chetaidouTask.findUnique.mockResolvedValue({
        id: "task-1",
        requestHash: "reqhash",
        type: "IDEATION",
        rootTaskId: "task-1",
        ownerId: 1,
        imageGenJobId: null,
        snapshot: {},
        progress: null,
      })
      mockPrisma.chetaidouGroup.findMany.mockResolvedValue([])
      mockPrisma.imageGenItem.findMany.mockResolvedValue([])
      const result = await service.createTask(1, {
        type: "IDEATION",
        imageId: 19,
        idempotencyKey: "key-1",
      } as never)
      expect((result as { id: string }).id).toBe("task-1")
    })

    it("同键异内容 409 IDEMPOTENCY_CONFLICT", async () => {
      mockPrisma.chetaidouTask.findFirst.mockResolvedValue({
        id: "task-1",
        requestHash: "different-hash",
      })
      await expect(
        service.createTask(1, {
          type: "IDEATION",
          imageId: 19,
          idempotencyKey: "key-1",
        } as never)
      ).rejects.toThrow(ConflictException)
    })
  })

  it("自建多选维度的组合可使用超过 60 个已选项，AI 历史多选组仍按单选校验", async () => {
    const options = Array.from({ length: 75 }, (_, i) => ({
      key: `option-${i}`,
      selectionId: `selection-${i}`,
      label: `选项 ${i}`,
      changeInstruction: `修改 ${i}`,
      requiresEvidence: false,
    }))
    const group = {
      id: "group-1",
      definition: { key: "background", label: "场景", selectionMode: "multi", kind: "visual" },
      options,
    }
    mockPrisma.chetaidouGroup.findMany.mockResolvedValue([group])
    const draft = {
      activeGroupRefs: [{ groupId: group.id }],
      selections: [] as { groupId: string; optionKeys: string[]; customText?: string }[],
      customDimensions: [
        {
          id: "custom-1",
          label: "自建场景",
          selectionMode: "multi",
          options: options.map(o => ({ key: o.key, text: o.label })),
          selectedKeys: options.map(o => o.key),
        },
      ],
    }
    const result = await service.resolveSelections(1, 19, draft as never, null)
    expect(result.selections).toHaveLength(75)
    draft.customDimensions[0].selectionMode = "single"
    await expect(service.resolveSelections(1, 19, draft as never, null)).rejects.toThrow(
      "自建维度「自建场景」是单选"
    )
    draft.customDimensions[0].selectionMode = "multi"
    draft.selections = [{ groupId: group.id, optionKeys: options.map(o => o.key) }]
    await expect(service.resolveSelections(1, 19, draft as never, null)).rejects.toThrow(
      "是单选，不可选择多项"
    )
    draft.selections = [{ groupId: group.id, optionKeys: [options[0].key], customText: "自填方案" }]
    await expect(service.resolveSelections(1, 19, draft as never, null)).rejects.toThrow(
      "是单选，不可选择多项"
    )
  })

  it("可执行选项的遮挡条件传入组合，需证据的同类选项仍拒绝", async () => {
    const option = {
      key: "shorts",
      selectionId: "s1",
      label: "浅灰短袖配黑色运动短裤",
      changeInstruction: "替换为短裤",
      preserveInstruction: "保留腿部对未知下部车架的合理遮挡",
      requiresEvidence: false,
    }
    mockPrisma.chetaidouGroup.findMany.mockResolvedValue([
      {
        id: "g1",
        definition: { key: "clothes", selectionMode: "single", kind: "visual" },
        options: [option],
      },
    ])
    const draft = {
      activeGroupRefs: [{ groupId: "g1" }],
      selections: [{ groupId: "g1", optionKeys: ["shorts"] }],
      customDimensions: [],
    }
    const result = await service.resolveSelections(1, 19, draft as never, null)
    expect(result.selections[0]).toMatchObject({ preserveInstruction: option.preserveInstruction })
    option.requiresEvidence = true
    await expect(service.resolveSelections(1, 19, draft as never, null)).rejects.toThrow(
      "需要补充证据"
    )
  })

  it("批量状态请求不截断第 50 个之后的任务", async () => {
    const ids = Array.from({ length: 75 }, (_, i) => `task-${i}`)
    mockPrisma.chetaidouTask.findMany.mockResolvedValue([])
    await service.tasksStatus(1, ids)
    expect(mockPrisma.chetaidouTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ids }, ownerId: 1 } })
    )
  })

  describe("putDraft 乐观锁", () => {
    it("CAS 失败（revision 不匹配）抛 409 SETTINGS_CHANGED", async () => {
      mockPrisma.chetaidouImage.findUnique.mockResolvedValue({
        id: 19,
        skuId: 1,
        enabled: true,
        sourceType: "PRESET",
        ownerId: null,
        currentBreakdownId: null,
      })
      mockPrisma.chetaidouSku.findUnique.mockResolvedValue({
        id: 1,
        enabled: true,
        currentFactId: 1,
      })
      mockPrisma.chetaidouFactCard.findUnique.mockResolvedValue({ id: 1, version: 1 })
      mockPrisma.chetaidouDraft.updateMany.mockResolvedValue({ count: 0 })
      mockPrisma.chetaidouDraft.findUnique.mockResolvedValue({
        id: 1,
        ownerId: 1,
        imageId: 19,
        revision: 8,
        settings: {},
        selections: [],
        customDimensions: [],
      })
      await expect(
        service.putDraft(1, 19, {
          revision: 6,
          settings: {
            site: "original",
            textMode: "keep",
            personMode: "keep",
            personText: "",
            customText: "",
          },
          selections: [],
          customDimensions: [],
        })
      ).rejects.toThrow(ConflictException)
    })
  })
})
