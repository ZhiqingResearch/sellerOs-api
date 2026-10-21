import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { PrismaService } from "../prisma/prisma.service"
import { CreateRecordDto } from "./dto/create-record.dto"
import { UpdateRecordDto } from "./dto/update-record.dto"
import { ProductFactoryService } from "./product-factory.service"

describe("ProductFactoryService", () => {
  let service: ProductFactoryService
  let prisma: {
    productFactoryRecord: {
      findMany: jest.Mock
      count: jest.Mock
      findFirst: jest.Mock
      create: jest.Mock
      update: jest.Mock
    }
  }

  const existingRecord = {
    id: 1,
    userId: 7,
    sourceType: "competitor",
    productName: "竞品复刻 · B0C1X2Y3Z4",
    market: "amazon_us",
    status: "draft",
    currentStep: 1,
    totalSteps: 6,
    sourceInput: { competitorUrls: ["B0C1X2Y3Z4"], market: "amazon_us" },
    step1Data: null,
    step4Data: null,
    thumbnailUrl: null,
  }

  interface CreateArgs {
    data: Record<string, unknown>
  }
  interface FindManyArgs {
    where: Record<string, unknown>
    orderBy: Record<string, string>
    skip: number
    take: number
  }
  interface UpdateArgs {
    where: { id: number }
    data: Record<string, unknown>
  }

  const createArgs = (): CreateArgs =>
    (prisma.productFactoryRecord.create.mock.calls as [CreateArgs][])[0][0]
  const findManyArgs = (): FindManyArgs =>
    (prisma.productFactoryRecord.findMany.mock.calls as [FindManyArgs][])[0][0]
  const countArgs = (): { where: Record<string, unknown> } =>
    (prisma.productFactoryRecord.count.mock.calls as [{ where: Record<string, unknown> }][])[0][0]
  const updateArgs = (call = 0): UpdateArgs =>
    (prisma.productFactoryRecord.update.mock.calls as [UpdateArgs][])[call][0]

  beforeEach(async () => {
    prisma = {
      productFactoryRecord: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    }

    const module = await Test.createTestingModule({
      providers: [ProductFactoryService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(ProductFactoryService)
  })

  describe("用户隔离", () => {
    it("findOne: findFirst 查不到（含跨用户）抛 NotFoundException", async () => {
      prisma.productFactoryRecord.findFirst.mockResolvedValue(null)

      await expect(service.findOne(7, 1)).rejects.toBeInstanceOf(NotFoundException)
      expect(prisma.productFactoryRecord.findFirst).toHaveBeenCalledWith({
        where: { id: 1, userId: 7 },
      })
    })

    it("update: findFirst 查不到（含跨用户）抛 NotFoundException 且不写库", async () => {
      prisma.productFactoryRecord.findFirst.mockResolvedValue(null)

      await expect(service.update(7, 1, { productName: "x" })).rejects.toBeInstanceOf(
        NotFoundException
      )
      expect(prisma.productFactoryRecord.update).not.toHaveBeenCalled()
    })

    it("remove: findFirst 查不到（含跨用户）抛 NotFoundException 且不写库", async () => {
      prisma.productFactoryRecord.findFirst.mockResolvedValue(null)

      await expect(service.remove(7, 1)).rejects.toBeInstanceOf(NotFoundException)
      expect(prisma.productFactoryRecord.update).not.toHaveBeenCalled()
    })

    it("findAll: where 必含 userId", async () => {
      prisma.productFactoryRecord.findMany.mockResolvedValue([])
      prisma.productFactoryRecord.count.mockResolvedValue(0)

      await service.findAll(7, { page: 1, pageSize: 10 })

      const where = findManyArgs().where
      expect(where.userId).toBe(7)
      const countWhere = countArgs().where
      expect(countWhere.userId).toBe(7)
    })
  })

  describe("CreateRecordDto 校验", () => {
    const validPayload = {
      sourceType: "competitor",
      sourceInput: {
        competitorUrls: ["https://www.amazon.com/dp/B0C1X2Y3Z4"],
        market: "amazon_us",
      },
    }

    async function validateCreate(payload: unknown) {
      return validate(plainToInstance(CreateRecordDto, payload))
    }

    it("competitorUrls 为 0 个 → 竞品来源由服务层拒绝（自有商品允许为空）", async () => {
      // DTO 层不再强制 min 1（自有商品来源可为空）；竞品来源的最少数量校验移到 service.create。
      const errors = await validateCreate({
        ...validPayload,
        sourceInput: { ...validPayload.sourceInput, competitorUrls: [] },
      })
      expect(errors).toHaveLength(0)
      await expect(
        service.create(7, {
          sourceType: "competitor",
          sourceInput: { competitorUrls: [], market: "amazon_us" },
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it("competitorUrls 为 4 个 → 校验失败", async () => {
      const errors = await validateCreate({
        ...validPayload,
        sourceInput: {
          ...validPayload.sourceInput,
          competitorUrls: ["B0C1X2Y3Z4", "B0C1X2Y3Z5", "B0C1X2Y3Z6", "B0C1X2Y3Z7"],
        },
      })
      expect(errors.length).toBeGreaterThan(0)
    })

    it("competitorUrls 元素既非 Amazon URL 也非 10 位 ASIN → 校验失败", async () => {
      const errors = await validateCreate({
        ...validPayload,
        sourceInput: { ...validPayload.sourceInput, competitorUrls: ["not-a-url"] },
      })
      expect(errors.length).toBeGreaterThan(0)
    })

    it("market 非法值 → 校验失败", async () => {
      const errors = await validateCreate({
        ...validPayload,
        sourceInput: { ...validPayload.sourceInput, market: "amazon_jp" },
      })
      expect(errors.length).toBeGreaterThan(0)
    })

    it("sourceType 未支持的来源 → 校验失败", async () => {
      const errors = await validateCreate({ ...validPayload, sourceType: "selection" })
      expect(errors.length).toBeGreaterThan(0)
    })

    it("sourceType own_product → 校验通过", async () => {
      const errors = await validateCreate({
        sourceType: "own_product",
        sourceInput: { competitorUrls: [], market: "amazon_us" },
      })
      expect(errors).toHaveLength(0)
    })

    it("合法入参 → 校验通过", async () => {
      const errors = await validateCreate(validPayload)
      expect(errors).toHaveLength(0)
    })

    describe("ourProduct.documents / purchaseInfo（宽松校验）", () => {
      const payloadWithOurProduct = {
        ...validPayload,
        sourceInput: {
          ...validPayload.sourceInput,
          ourProduct: {
            name: "便携榨汁杯 400ml",
            documents: [{ name: "规格表.txt", content: "容量 400ml", extraField: "前端新增字段" }],
            purchaseInfo: { platform: "1688", price: "¥12.50", unknownKey: 1 },
          },
        },
      }

      it("documents 含未知字段 → 校验通过（结构未冻结，不报错）", async () => {
        const errors = await validateCreate(payloadWithOurProduct)
        expect(errors).toHaveLength(0)
      })

      it("whitelist 模式下 documents/purchaseInfo 的未知字段不被剥离", async () => {
        const instance = plainToInstance(CreateRecordDto, payloadWithOurProduct)
        await validate(instance, { whitelist: true })

        const ourProduct = instance.sourceInput.ourProduct as Record<string, unknown>
        const documents = ourProduct.documents as Record<string, unknown>[]
        expect(documents[0].extraField).toBe("前端新增字段")
        expect((ourProduct.purchaseInfo as Record<string, unknown>).unknownKey).toBe(1)
      })

      it("documents 非数组 → 校验失败", async () => {
        const errors = await validateCreate({
          ...validPayload,
          sourceInput: {
            ...validPayload.sourceInput,
            ourProduct: { documents: "not-an-array" },
          },
        })
        expect(errors.length).toBeGreaterThan(0)
      })

      it("documents 元素非对象 → 校验失败", async () => {
        const errors = await validateCreate({
          ...validPayload,
          sourceInput: {
            ...validPayload.sourceInput,
            ourProduct: { documents: ["plain-string"] },
          },
        })
        expect(errors.length).toBeGreaterThan(0)
      })

      it("purchaseInfo 非对象 → 校验失败", async () => {
        const errors = await validateCreate({
          ...validPayload,
          sourceInput: {
            ...validPayload.sourceInput,
            ourProduct: { purchaseInfo: "not-an-object" },
          },
        })
        expect(errors.length).toBeGreaterThan(0)
      })
    })
  })

  describe("create 成功路径", () => {
    function setupCreate() {
      prisma.productFactoryRecord.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 1, ...data })
      )
    }

    it("写死 totalSteps=6 / currentStep=1 / status=draft", async () => {
      setupCreate()

      await service.create(7, {
        sourceType: "competitor",
        sourceInput: { competitorUrls: ["B0C1X2Y3Z4"], market: "amazon_us" },
      })

      const data = createArgs().data
      expect(data.totalSteps).toBe(6)
      expect(data.currentStep).toBe(1)
      expect(data.status).toBe("draft")
      expect(data.userId).toBe(7)
    })

    it("纯 ASIN 输入 → productName 提取 ASIN", async () => {
      setupCreate()

      await service.create(7, {
        sourceType: "competitor",
        sourceInput: { competitorUrls: ["B0C1X2Y3Z4"], market: "amazon_us" },
      })

      expect(createArgs().data.productName).toBe("竞品复刻 · B0C1X2Y3Z4")
    })

    it("own_product 来源 → totalSteps=5 / 命名取我方资料 / 不需要竞品链接", async () => {
      setupCreate()

      await service.create(7, {
        sourceType: "own_product",
        sourceInput: {
          competitorUrls: [],
          market: "amazon_us",
          ourProduct: {
            documents: [{ name: "规格表.txt", content: "容量 400ml" }],
          },
        },
      })

      const data = createArgs().data
      expect(data.totalSteps).toBe(5)
      expect(data.productName).toBe("自有商品 · 规格表.txt")
    })

    it("amazon.com/dp/ URL → productName 提取 ASIN", async () => {
      setupCreate()

      await service.create(7, {
        sourceType: "competitor",
        sourceInput: {
          competitorUrls: ["https://www.amazon.com/dp/B0C1X2Y3Z4?ref=sr_1_1"],
          market: "amazon_us",
        },
      })

      expect(createArgs().data.productName).toBe("竞品复刻 · B0C1X2Y3Z4")
    })

    it("amazon.co.uk/gp/product/ URL → productName 提取 ASIN", async () => {
      setupCreate()

      await service.create(7, {
        sourceType: "competitor",
        sourceInput: {
          competitorUrls: ["https://www.amazon.co.uk/gp/product/B0ABCDEFGH"],
          market: "amazon_uk",
        },
      })

      expect(createArgs().data.productName).toBe("竞品复刻 · B0ABCDEFGH")
    })

    it("提取不到 ASIN → productName 兜底取 URL 前 40 字符", async () => {
      setupCreate()
      const url = "https://www.amazon.com/Portable-Juicer-Cup-Rechargeable"

      await service.create(7, {
        sourceType: "competitor",
        sourceInput: { competitorUrls: [url], market: "amazon_us" },
      })

      expect(createArgs().data.productName).toBe(`竞品复刻 · ${url.slice(0, 40)}`)
    })
  })

  describe("UpdateRecordDto 校验", () => {
    async function validateUpdate(payload: unknown) {
      return validate(plainToInstance(UpdateRecordDto, payload))
    }

    it("status 非法值 → 校验失败", async () => {
      const errors = await validateUpdate({ status: "archived" })
      expect(errors.length).toBeGreaterThan(0)
    })

    it("currentStep=0 → 校验失败", async () => {
      const errors = await validateUpdate({ currentStep: 0 })
      expect(errors.length).toBeGreaterThan(0)
    })
  })

  describe("update 服务层校验与缩略图", () => {
    beforeEach(() => {
      prisma.productFactoryRecord.findFirst.mockResolvedValue({ ...existingRecord })
      prisma.productFactoryRecord.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...existingRecord, ...data })
      )
    })

    it("currentStep 超过已存记录 totalSteps → BadRequestException", async () => {
      await expect(service.update(7, 1, { currentStep: 7 })).rejects.toBeInstanceOf(
        BadRequestException
      )
      expect(prisma.productFactoryRecord.update).not.toHaveBeenCalled()
    })

    it("未传 step1Data/step4Data → update data 不含 thumbnailUrl", async () => {
      await service.update(7, 1, { productName: "新名字", status: "in_progress" })

      const data = updateArgs().data
      expect(data).not.toHaveProperty("thumbnailUrl")
      expect(data.productName).toBe("新名字")
      expect(data.status).toBe("in_progress")
    })

    it("传 step4Data 且含主图 URL（slots[0].url）→ thumbnailUrl 取 step4 的值", async () => {
      await service.update(7, 1, {
        step1Data: { competitors: [{ imageUrl: "https://oss.example.com/step1.jpg" }] },
        step4Data: { slots: [{ url: "https://oss.example.com/step4-main.jpg" }] },
      })

      const data = updateArgs().data
      expect(data.thumbnailUrl).toBe("https://oss.example.com/step4-main.jpg")
    })

    it("只传 step1Data（无 step4Data）→ thumbnailUrl 取 step1Data.competitors[0].imageUrl", async () => {
      await service.update(7, 1, {
        step1Data: { competitors: [{ imageUrl: "https://oss.example.com/comp1.jpg" }] },
      })

      const data = updateArgs().data
      expect(data.thumbnailUrl).toBe("https://oss.example.com/comp1.jpg")
    })

    it("step4Data 无任何 URL + step1Data 有 → 回退 step1", async () => {
      await service.update(7, 1, {
        step1Data: { competitors: [{ imageUrl: "https://oss.example.com/comp1.jpg" }] },
        step4Data: { slots: [{ url: "" }], notes: "no image yet" },
      })

      const data = updateArgs().data
      expect(data.thumbnailUrl).toBe("https://oss.example.com/comp1.jpg")
    })

    it("缩略图 URL 超过 500 字符 → 截断到 500 再入库（防 VarChar(500) 写库报错）", async () => {
      const longUrl = `https://oss.example.com/step4-main.jpg?sig=${"a".repeat(600)}`

      await service.update(7, 1, { step4Data: { slots: [{ url: longUrl }] } })

      const data = updateArgs().data
      expect(data.thumbnailUrl).toHaveLength(500)
      expect(data.thumbnailUrl).toBe(longUrl.slice(0, 500))
    })
  })

  describe("remove 软删除", () => {
    it("调 update 写入 deletedAt（Date），不物理删除", async () => {
      prisma.productFactoryRecord.findFirst.mockResolvedValue({ ...existingRecord })
      prisma.productFactoryRecord.update.mockResolvedValue({ ...existingRecord })

      await service.remove(7, 1)

      const args = updateArgs()
      expect(args.where).toEqual({ id: 1 })
      expect(args.data.deletedAt).toBeInstanceOf(Date)
    })
  })

  describe("findAll 列表", () => {
    beforeEach(() => {
      prisma.productFactoryRecord.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }])
      prisma.productFactoryRecord.count.mockResolvedValue(2)
    })

    it("keyword 传入时 where 含 productName contains", async () => {
      await service.findAll(7, { page: 1, pageSize: 10, keyword: "榨汁" })

      const where = findManyArgs().where
      expect(where.productName).toEqual({ contains: "榨汁" })
    })

    it("sourceType/status 精确匹配", async () => {
      await service.findAll(7, {
        page: 1,
        pageSize: 10,
        sourceType: "competitor",
        status: "in_progress",
      })

      const where = findManyArgs().where
      expect(where.sourceType).toBe("competitor")
      expect(where.status).toBe("in_progress")
    })

    it("orderBy updatedAt desc 且分页参数正确", async () => {
      await service.findAll(7, { page: 2, pageSize: 10 })

      const args = findManyArgs()
      expect(args.orderBy).toEqual({ updatedAt: "desc" })
      expect(args.skip).toBe(10)
      expect(args.take).toBe(10)
    })

    it("返回 { items, total, page, pageSize }", async () => {
      const result = await service.findAll(7, { page: 1, pageSize: 10 })

      expect(result).toEqual({
        items: [{ id: 1 }, { id: 2 }],
        total: 2,
        page: 1,
        pageSize: 10,
      })
    })
  })
})
