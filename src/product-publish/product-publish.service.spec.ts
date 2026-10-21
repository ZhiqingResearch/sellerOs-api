/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { ProductPublishTaskStatus } from "@prisma/client"
import { ZixiaoyunProvider } from "../common/providers/zixiaoyun.provider"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import { PRODUCT_PUBLISH_CLASSIFICATIONS } from "./product-publish.constants"
import { ProductPublishService } from "./product-publish.service"

describe("ProductPublishService", () => {
  let service: ProductPublishService
  let prisma: {
    productPublishTask: {
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      findFirst: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
    }
    imageProject: { findFirst: jest.Mock }
    productPublishStore: { findUnique: jest.Mock }
    productPublishStoreClassification: { findUnique: jest.Mock; findMany: jest.Mock }
  }
  let spaces: {
    getPublicUrl: jest.Mock
    generateUploadUrl: jest.Mock
    objectExists: jest.Mock
  }
  let zixiaoyun: { washImageUrl: jest.Mock }

  const baseTask = {
    id: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    imageProjectId: null,
    productName: null,
    brand: null,
    classification: null,
    category: null,
    data: null,
    status: ProductPublishTaskStatus.DRAFT,
    store: null,
    publishStoreId: null,
    type: null,
    productImages: null,
    progress: 0,
    spreadsheetUrl: null,
    spreadsheetKey: null,
    completedAt: null,
    uploadId: null,
    rpaTaskUuid: null,
    rpaJobUuidList: null,
    submitRequestId: null,
    successCount: 0,
    failedCount: 0,
    submittedFileUrl: null,
    resultFileUrl: null,
    skus: null,
    skuAsinMapping: null,
    publishOutcome: null,
    publishSubmittedAt: null,
    publishCompletedAt: null,
    lastPolledAt: null,
    nextPollAt: null,
    pollAttempts: 0,
    publishErrorMessage: null,
    createdAt: new Date("2026-07-23T00:00:00Z"),
    updatedAt: new Date("2026-07-23T00:00:00Z"),
    deletedAt: null,
  }

  beforeEach(() => {
    prisma = {
      productPublishTask: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      imageProject: { findFirst: jest.fn() },
      productPublishStore: { findUnique: jest.fn() },
      productPublishStoreClassification: { findUnique: jest.fn(), findMany: jest.fn() },
    }
    spaces = {
      getPublicUrl: jest.fn(key => `https://cdn.example.com/${key}`),
      generateUploadUrl: jest.fn(),
      objectExists: jest.fn(),
    }
    zixiaoyun = { washImageUrl: jest.fn() }
    service = new ProductPublishService(
      prisma as unknown as PrismaService,
      spaces as unknown as SpacesService,
      zixiaoyun as unknown as ZixiaoyunProvider
    )
  })

  it("返回全部分类及模板 URL", () => {
    const result = service.getClassifications()

    expect(result).toHaveLength(12)
    expect(result.every(item => !item.code.includes("_"))).toBe(true)
    expect(result[0]).toMatchObject({
      code: "NOTEBOOK COMPUTER",
      templateUrl: "https://cdn.example.com/product-publish/templates/NOTEBOOK_COMPUTER.xlsm",
    })
    expect(result.map(item => item.templateFilename)).toEqual(
      PRODUCT_PUBLISH_CLASSIFICATIONS.map(item => item.templateFilename)
    )
  })

  it("创建草稿时自动生成 UUID", async () => {
    prisma.productPublishTask.create.mockImplementation(({ data }) => ({
      ...baseTask,
      ...data,
    }))

    const result = await service.createTask({}, 7)

    const data = prisma.productPublishTask.create.mock.calls[0][0].data
    expect(data.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(data.userId).toBe(7)
    expect(result.classificationInfo).toBeNull()
  })

  it("创建草稿时保存飞书店铺关联并校验分类", async () => {
    prisma.productPublishStore.findUnique.mockResolvedValue({
      id: 9,
      name: "Amazon US",
      shortName: "美区店",
      platform: "AMAZON",
      disabled: false,
    })
    prisma.productPublishStoreClassification.findUnique
      .mockResolvedValueOnce({ id: 99 })
      .mockResolvedValueOnce({
        classification: "HEADPHONES",
        classificationName: "Headphones",
        templateUrl: "https://rpa.example.com/headphones.xlsm",
        templateStatus: "SUCCESS",
        templateSyncedAt: new Date("2026-08-03T00:00:00Z"),
      })
    prisma.productPublishTask.create.mockImplementation(({ data }) => ({
      ...baseTask,
      ...data,
    }))

    const result = await service.createTask(
      { storeId: "27826971599669", classification: "HEADPHONES" },
      7
    )

    expect(prisma.productPublishStoreClassification.findUnique).toHaveBeenCalledWith({
      where: { storeId_classification: { storeId: 9, classification: "HEADPHONES" } },
      select: { id: true },
    })
    expect(prisma.productPublishTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishStoreId: 9,
          store: "美区店",
          classification: "HEADPHONES",
        }),
      })
    )
    expect(result.classificationInfo).toMatchObject({
      code: "HEADPHONES",
      name: "Headphones",
      templateUrl: "https://rpa.example.com/headphones.xlsm",
      templateStatus: "SUCCESS",
    })
  })

  it("拒绝使用已禁用店铺", async () => {
    prisma.productPublishStore.findUnique.mockResolvedValue({
      id: 9,
      name: "Amazon US",
      shortName: "美区店",
      platform: "AMAZON",
      disabled: true,
    })

    await expect(service.createTask({ storeId: "27826971599669" }, 7)).rejects.toBeInstanceOf(
      BadRequestException
    )
    expect(prisma.productPublishTask.create).not.toHaveBeenCalled()
  })

  it("当前只允许创建 Amazon 店铺任务", async () => {
    prisma.productPublishStore.findUnique.mockResolvedValue({
      id: 9,
      name: "其他平台店铺",
      shortName: null,
      platform: "OTHER",
      disabled: false,
    })

    await expect(service.createTask({ storeId: "27826971599669" }, 7)).rejects.toThrow(
      "当前仅支持 Amazon 店铺"
    )
    expect(prisma.productPublishTask.create).not.toHaveBeenCalled()
  })

  it("关联店铺时忽略客户端伪造的店铺展示名", async () => {
    prisma.productPublishStore.findUnique.mockResolvedValue({
      id: 9,
      name: "Amazon US",
      shortName: "美区店",
      platform: "AMAZON",
      disabled: false,
    })
    prisma.productPublishTask.create.mockImplementation(({ data }) => ({
      ...baseTask,
      ...data,
    }))

    await service.createTask({ storeId: "27826971599669", store: "伪造店铺名" }, 7)

    expect(prisma.productPublishTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishStoreId: 9, store: "美区店" }),
      })
    )
  })

  it("已有店铺关联时拒绝只修改自由文本店铺名", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue({ ...baseTask, publishStoreId: 9 })

    await expect(
      service.updateTask(baseTask.taskId, { store: "另一个店" }, 7)
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
  })

  it("不允许关联其他用户的图片项目", async () => {
    prisma.imageProject.findFirst.mockResolvedValue(null)

    await expect(service.createTask({ imageProjectId: 99 }, 7)).rejects.toBeInstanceOf(
      NotFoundException
    )
    expect(prisma.productPublishTask.create).not.toHaveBeenCalled()
  })

  it("不允许一个图片项目关联两个任务", async () => {
    prisma.imageProject.findFirst.mockResolvedValue({ id: 10 })
    prisma.productPublishTask.findFirst.mockResolvedValue({ taskId: "occupied" })

    await expect(service.createTask({ imageProjectId: 10 }, 7)).rejects.toBeInstanceOf(
      ConflictException
    )
  })

  it("未关联图片项目也能在表格存在时完成", async () => {
    const key = `product-publish/exports/7/${baseTask.taskId}/result.xlsx`
    prisma.productPublishTask.findFirst.mockResolvedValueOnce(baseTask).mockResolvedValueOnce({
      ...baseTask,
      status: ProductPublishTaskStatus.COMPLETED,
      progress: 100,
      spreadsheetKey: key,
      spreadsheetUrl: `https://cdn.example.com/${key}`,
    })
    spaces.objectExists.mockResolvedValue(true)

    await expect(
      service.completeTask(baseTask.taskId, { spreadsheetKey: key }, 7)
    ).resolves.toMatchObject({ status: ProductPublishTaskStatus.COMPLETED })
    expect(prisma.imageProject.findFirst).not.toHaveBeenCalled()
  })

  it("校验表格对象后完成任务", async () => {
    const linkedTask = { ...baseTask, imageProjectId: 10 }
    const key = `product-publish/exports/7/${baseTask.taskId}/result.xlsx`
    prisma.productPublishTask.findFirst.mockResolvedValueOnce(linkedTask).mockResolvedValueOnce({
      ...linkedTask,
      status: ProductPublishTaskStatus.COMPLETED,
      progress: 100,
      spreadsheetKey: key,
      spreadsheetUrl: `https://cdn.example.com/${key}`,
    })
    spaces.objectExists.mockResolvedValue(true)

    const result = await service.completeTask(baseTask.taskId, { spreadsheetKey: key }, 7)

    expect(spaces.objectExists).toHaveBeenCalledWith(key)
    expect(prisma.productPublishTask.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: baseTask.taskId,
        userId: 7,
        deletedAt: null,
        status: { not: ProductPublishTaskStatus.PUBLISHING },
        submitRequestId: null,
        uploadId: null,
      },
      data: expect.objectContaining({
        status: ProductPublishTaskStatus.COMPLETED,
        progress: 100,
        spreadsheetKey: key,
        spreadsheetUrl: `https://cdn.example.com/${key}`,
        completedAt: expect.any(Date),
      }),
    })
    expect(result.status).toBe(ProductPublishTaskStatus.COMPLETED)
  })

  it("拒绝其他任务目录下的表格", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValueOnce(baseTask)

    await expect(
      service.completeTask(
        baseTask.taskId,
        { spreadsheetKey: "product-publish/exports/8/other/result.xlsx" },
        7
      )
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("洗链逐条返回并持久化部分成功结果", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue({
      ...baseTask,
      productImages: [{ id: "img-1", originalUrl: "https://origin.example.com/a.jpg" }],
    })
    zixiaoyun.washImageUrl
      .mockResolvedValueOnce({ url: "https://washed.example.com/a.jpg" })
      .mockRejectedValueOnce(new Error("第三方下载失败"))

    const result = await service.washImageLinks(
      baseTask.taskId,
      {
        imageUrls: [
          "https://origin.example.com/a.jpg",
          "https://origin.example.com/b.jpg",
          "https://origin.example.com/a.jpg",
        ],
      },
      7
    )

    expect(zixiaoyun.washImageUrl).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ total: 2, successCount: 1, failedCount: 1 })
    expect(prisma.productPublishTask.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: baseTask.taskId,
        userId: 7,
        deletedAt: null,
        status: { not: ProductPublishTaskStatus.PUBLISHING },
        submitRequestId: null,
        uploadId: null,
      },
      data: {
        productImages: [
          {
            id: "img-1",
            originalUrl: "https://origin.example.com/a.jpg",
            washedUrl: "https://washed.example.com/a.jpg",
            washStatus: "SUCCESS",
          },
          {
            originalUrl: "https://origin.example.com/b.jpg",
            washStatus: "FAILED",
            errorMessage: "第三方下载失败",
          },
        ],
      },
    })
  })

  it("上架记录按关键字和维度组合查询", async () => {
    prisma.productPublishTask.count.mockResolvedValue(0)
    prisma.productPublishTask.findMany.mockResolvedValue([])

    await service.findRecords(
      {
        page: 2,
        pageSize: 20,
        keyword: "耳机",
        status: "COMPLETED",
        store: "A",
        storeId: "27826971599669",
        classification: "HEADPHONES",
        category: "蓝牙",
        type: "VARIANT",
      },
      7
    )

    expect(prisma.productPublishTask.findMany).toHaveBeenCalledWith({
      where: {
        userId: 7,
        status: "COMPLETED",
        store: "A",
        publishStore: { externalStoreId: "27826971599669" },
        classification: "HEADPHONES",
        type: "VARIANT",
        category: { contains: "蓝牙" },
        OR: [
          { productName: { contains: "耳机" } },
          { brand: { contains: "耳机" } },
          { category: { contains: "耳机" } },
        ],
      },
      include: {
        publishStore: {
          select: {
            externalStoreId: true,
            name: true,
            shortName: true,
            companyName: true,
            platform: true,
            accountType: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      skip: 20,
      take: 20,
    })
  })

  it("上架记录返回店铺专属模板链接而不是旧通用链接", async () => {
    prisma.productPublishTask.count.mockResolvedValue(1)
    prisma.productPublishTask.findMany.mockResolvedValue([
      {
        ...baseTask,
        publishStoreId: 9,
        classification: "HEADPHONES",
        publishStore: {
          externalStoreId: "27826971599669",
          name: "Amazon US",
          shortName: "美区店",
          companyName: "示例公司",
          platform: "AMAZON",
          accountType: "主账号",
        },
      },
    ])
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([
      {
        storeId: 9,
        classification: "HEADPHONES",
        classificationName: "Headphones",
        templateUrl: "https://rpa.example.com/store-9-headphones.xlsm",
        templateStatus: "SUCCESS",
        templateSyncedAt: new Date("2026-08-03T00:00:00Z"),
      },
    ])

    const result = await service.findRecords({ page: 1, pageSize: 10 }, 7)

    expect(result.items[0]).toMatchObject({
      uploadId: null,
      successCount: 0,
      failedCount: 0,
      publishStore: { externalStoreId: "27826971599669" },
      classificationInfo: {
        code: "HEADPHONES",
        templateUrl: "https://rpa.example.com/store-9-headphones.xlsm",
        templateStatus: "SUCCESS",
      },
    })
    expect(prisma.productPublishStoreClassification.findMany).toHaveBeenCalledWith({
      where: { OR: [{ storeId: 9, classification: "HEADPHONES" }] },
      select: {
        storeId: true,
        classification: true,
        classificationName: true,
        templateUrl: true,
        templateStatus: true,
        templateSyncedAt: true,
      },
    })
  })

  it("店铺分类映射异常缺失时不会回退到旧通用模板", async () => {
    prisma.productPublishTask.count.mockResolvedValue(1)
    prisma.productPublishTask.findMany.mockResolvedValue([
      {
        ...baseTask,
        publishStoreId: 9,
        classification: "HEADPHONES",
        publishStore: null,
      },
    ])
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([])

    const result = await service.findRecords({ page: 1, pageSize: 10 }, 7)
    const items = result.items as unknown as Array<{ classificationInfo: unknown }>

    expect(items[0].classificationInfo).toMatchObject({
      code: "HEADPHONES",
      templateUrl: null,
      templateStatus: "PENDING",
    })
  })

  it("上架中任务不能修改或删除", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue({
      ...baseTask,
      status: ProductPublishTaskStatus.PUBLISHING,
    })

    await expect(
      service.updateTask(baseTask.taskId, { productName: "新名称" }, 7)
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(service.deleteRecord(baseTask.taskId, 7)).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
  })

  it("任务在读写之间进入上架流程时原子更新拒绝修改", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue(baseTask)
    prisma.productPublishTask.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      service.updateTask(baseTask.taskId, { productName: "并发修改" }, 7)
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.productPublishTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          taskId: baseTask.taskId,
          status: { not: ProductPublishTaskStatus.PUBLISHING },
          submitRequestId: null,
          uploadId: null,
        }),
      })
    )
  })

  it("一旦分配上架请求号，即使尚未收到Amazon批次也锁定任务", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue({
      ...baseTask,
      status: ProductPublishTaskStatus.COMPLETED,
      submitRequestId: "submit-request-1",
    })

    await expect(
      service.generateSpreadsheetUploadUrl(baseTask.taskId, { filename: "again.xlsx" }, 7)
    ).rejects.toBeInstanceOf(ConflictException)
    expect(spaces.generateUploadUrl).not.toHaveBeenCalled()
  })

  it("软删除仅操作当前用户任务", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue(baseTask)
    await expect(service.deleteRecord(baseTask.taskId, 7)).resolves.toEqual({
      message: "上架记录已删除",
    })
    expect(prisma.productPublishTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: baseTask.taskId, userId: 7 },
      })
    )
    expect(prisma.productPublishTask.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: baseTask.taskId,
        userId: 7,
        deletedAt: null,
        status: { not: ProductPublishTaskStatus.PUBLISHING },
        submitRequestId: null,
        uploadId: null,
      },
      data: { deletedAt: expect.any(Date), imageProjectId: null },
    })
  })
})
