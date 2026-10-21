import { Test } from "@nestjs/testing"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { ChetaidouContextService, TaskSnapshot } from "./chetaidou-context.service"
import { CHETAIDOU_BREAKDOWN_CATEGORY, CHETAIDOU_IMAGE_CATEGORY, CHETAIDOU_TEXT_CATEGORY } from "./chetaidou.constants"

describe("车泰斗按分类选择模型", () => {
  const findMany = jest.fn()
  let service: ChetaidouContextService
  let models: TaskSnapshot["models"]

  beforeEach(async () => {
    findMany.mockReset()
    models = {
      text: { publicId: "configured-text", category: CHETAIDOU_TEXT_CATEGORY },
      image: { publicId: "configured-image", category: CHETAIDOU_IMAGE_CATEGORY },
    }
    findMany.mockImplementation(({ where }: { where: Prisma.AiGatewayModelWhereInput }) =>
      Promise.resolve([where.modality === "TEXT" ? models.text : models.image])
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouContextService,
        { provide: PrismaService, useValue: { aiGatewayModel: { findMany } } },
      ],
    }).compile()
    service = moduleRef.get(ChetaidouContextService)
  })

  it("读取业务分类，目录换模型后新任务使用新模型，旧快照不变", async () => {
    const input = {
      image: {} as TaskSnapshot["image"],
      fact: {} as TaskSnapshot["facts"],
      breakdown: null,
      settings: {},
    }
    const first = await service.buildSnapshot(input)
    expect(first.models).toEqual(models)
    for (const [modality, category] of [
      ["TEXT", CHETAIDOU_TEXT_CATEGORY],
      ["IMAGE", CHETAIDOU_IMAGE_CATEGORY],
    ]) {
      expect(findMany).toHaveBeenCalledWith({
        where: { category, modality, enabled: true, gatewayActive: true },
        select: { publicId: true, category: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 1,
      })
    }
    models.image = { ...models.image, publicId: "replacement-image" }
    const second = await service.buildSnapshot(input)
    expect(second.models.image.publicId).toBe("replacement-image")
    expect(first.models.image.publicId).toBe("configured-image")
    findMany.mockClear()
    const comparison = await service.buildSnapshot({ ...input, models: first.models })
    expect(comparison.models).toEqual(first.models)
    expect(findMany).not.toHaveBeenCalled()
  })

  it.each([[]])("分类缺行时拒绝调用，不回落硬编码模型：%j", async (...rows) => {
    findMany.mockResolvedValue(rows)
    await expect(service.resolveModels()).rejects.toMatchObject({
      response: { code: "MODEL_NOT_READY" },
    })
  })

  it("重试只检查原快照模型，不自动切换到分类中的新模型", async () => {
    await service.resolveModels(models)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publicId: "configured-image",
          category: CHETAIDOU_IMAGE_CATEGORY,
        }) as Prisma.AiGatewayModelWhereInput,
      })
    )
    findMany.mockResolvedValue([])
    await expect(service.resolveModels(models)).rejects.toMatchObject({
      response: { code: "MODEL_NOT_READY" },
    })
  })

  it("拆解只读独立分类，缺配置时不回落联想分类", async () => {
    findMany.mockImplementation(({ where }: { where: Prisma.AiGatewayModelWhereInput }) =>
      Promise.resolve(where.modality === "IMAGE" ? [models.image]
        : where.category === CHETAIDOU_BREAKDOWN_CATEGORY
          ? [{ publicId: "qwen3.8-max", category: CHETAIDOU_BREAKDOWN_CATEGORY }] : [models.text])
    )
    expect((await service.resolveBreakdownModels()).text).toEqual({
      publicId: "qwen3.8-max", category: CHETAIDOU_BREAKDOWN_CATEGORY,
    })
    expect((await service.resolveModels()).text).toEqual(models.text)
    findMany.mockImplementation(({ where }: { where: Prisma.AiGatewayModelWhereInput }) =>
      Promise.resolve(where.category === CHETAIDOU_BREAKDOWN_CATEGORY ? [] : [models.image])
    )
    await expect(service.resolveBreakdownModels()).rejects.toMatchObject({ response: { code: "MODEL_NOT_READY" } })
  })

  it("同分类多个文本模型可共存，用户选择绑定 publicId，缺少显式模型不回退", async () => {
    findMany.mockImplementation(({ where }: { where: Prisma.AiGatewayModelWhereInput }) => {
      if (where.modality === "IMAGE") return Promise.resolve([models.image])
      if (where.publicId)
        return Promise.resolve(
          where.publicId === "chosen"
            ? [{ publicId: "chosen", category: CHETAIDOU_TEXT_CATEGORY }]
            : []
        )
      return Promise.resolve([
        models.text,
        { publicId: "chosen", category: CHETAIDOU_TEXT_CATEGORY },
      ])
    })
    expect((await service.resolveModels()).text.publicId).toBe(models.text.publicId)
    expect((await service.resolveModels(undefined, "chosen")).text.publicId).toBe("chosen")
    await expect(service.resolveModels(undefined, "missing")).rejects.toMatchObject({
      response: { code: "MODEL_NOT_READY" },
    })
  })
})
