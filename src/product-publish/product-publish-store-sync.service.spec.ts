/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  ProductPublishFeishuSyncAction,
  ProductPublishFeishuSyncRecordStatus,
  ProductPublishFeishuSyncStatus,
  ProductPublishFeishuSyncTrigger,
} from "@prisma/client"
import { FeishuProvider } from "../common/providers/feishu.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ProductPublishStoreSyncService } from "./product-publish-store-sync.service"
import { PRODUCT_PUBLISH_CLASSIFICATIONS } from "./product-publish.constants"

describe("ProductPublishStoreSyncService", () => {
  let prisma: {
    productPublishFeishuSyncRun: { create: jest.Mock; update: jest.Mock }
    productPublishFeishuSyncRecord: { create: jest.Mock }
    productPublishClassificationCatalog: { createMany: jest.Mock; findMany: jest.Mock }
    productPublishStore: { findUnique: jest.Mock; upsert: jest.Mock }
    productPublishStoreClassification: { createMany: jest.Mock }
  }
  let feishu: { isConfigured: jest.Mock; searchStoreRecords: jest.Mock }
  let service: ProductPublishStoreSyncService

  beforeEach(() => {
    prisma = {
      productPublishFeishuSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 41 }),
        update: jest.fn().mockResolvedValue({ id: 41 }),
      },
      productPublishFeishuSyncRecord: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
      },
      productPublishClassificationCatalog: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue(
          PRODUCT_PUBLISH_CLASSIFICATIONS.map((item, sortOrder) => ({
            code: item.code,
            name: item.name,
            sortOrder,
          }))
        ),
      },
      productPublishStore: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({ id: 1 }),
      },
      productPublishStoreClassification: {
        createMany: jest.fn().mockResolvedValue({ count: 12 }),
      },
    }
    feishu = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchStoreRecords: jest.fn(),
    }
    service = new ProductPublishStoreSyncService(
      prisma as unknown as PrismaService,
      feishu as unknown as FeishuProvider
    )
  })

  it("启动时幂等补齐初始12个分类，兼容 db push 部署", async () => {
    prisma.productPublishClassificationCatalog.createMany.mockResolvedValue({ count: 12 })

    await service.onModuleInit()

    expect(prisma.productPublishClassificationCatalog.createMany).toHaveBeenCalledWith({
      data: PRODUCT_PUBLISH_CLASSIFICATIONS.map((item, sortOrder) => ({
        code: item.code,
        name: item.name,
        sortOrder,
      })),
      skipDuplicates: true,
    })
  })

  it("未配置飞书时也记录一次跳过的同步批次", async () => {
    feishu.isConfigured.mockReturnValue(false)

    await expect(
      service.syncFromFeishu(ProductPublishFeishuSyncTrigger.SCHEDULED)
    ).resolves.toEqual({
      runId: 41,
      configured: false,
      status: ProductPublishFeishuSyncStatus.SKIPPED,
      total: 0,
      created: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
    })
    expect(feishu.searchStoreRecords).not.toHaveBeenCalled()
    expect(prisma.productPublishFeishuSyncRun.create).toHaveBeenCalledWith({
      data: {
        trigger: ProductPublishFeishuSyncTrigger.SCHEDULED,
        status: ProductPublishFeishuSyncStatus.RUNNING,
        startedAt: expect.any(Date),
      },
      select: { id: true },
    })
    expect(prisma.productPublishFeishuSyncRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: ProductPublishFeishuSyncStatus.SKIPPED,
        errorMessage: expect.stringContaining("缺少 FEISHU_* 配置"),
        finishedAt: expect.any(Date),
      }),
    })
  })

  it("完整拉取飞书数据后按店铺ID新增店铺，并补齐12个分类及成功日志", async () => {
    feishu.searchStoreRecords.mockResolvedValue([
      {
        recordId: "rec-1",
        lastModifiedTime: 1785686400000,
        fields: {
          UUID: "store-uuid",
          公司: "示例公司",
          平台: "amazon",
          店铺类型: "跨境",
          账号类型: "主账号",
          紫鸟店铺: "Amazon US",
          店铺简称: "美区店",
          子店铺: "US-01",
          站点: "US",
          备注: "测试",
          店铺ID: "27826971599669",
          是否禁用: false,
        },
      },
    ])
    prisma.productPublishStore.findUnique.mockResolvedValue(null)

    await expect(service.syncFromFeishu()).resolves.toMatchObject({
      runId: 41,
      configured: true,
      status: ProductPublishFeishuSyncStatus.SUCCESS,
      total: 1,
      created: 1,
      updated: 0,
      failed: 0,
      skipped: 0,
    })
    expect(prisma.productPublishStore.upsert).toHaveBeenCalledWith({
      where: { externalStoreId: "27826971599669" },
      create: expect.objectContaining({
        externalStoreId: "27826971599669",
        name: "Amazon US",
        shortName: "美区店",
        companyName: "示例公司",
        platform: "AMAZON",
        disabled: false,
        lastSyncedAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        externalStoreId: "27826971599669",
        lastSyncedAt: expect.any(Date),
      }),
      select: { id: true },
    })
    expect(prisma.productPublishStoreClassification.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          storeId: 1,
          classification: "NOTEBOOK COMPUTER",
          classificationName: "laptop",
          sortOrder: 0,
        }),
      ]),
      skipDuplicates: true,
    })
    expect(prisma.productPublishStoreClassification.createMany.mock.calls[0][0].data).toHaveLength(
      12
    )
    expect(prisma.productPublishFeishuSyncRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: 41,
        feishuRecordId: "rec-1",
        externalStoreId: "27826971599669",
        status: ProductPublishFeishuSyncRecordStatus.SUCCESS,
        action: ProductPublishFeishuSyncAction.CREATED,
      }),
    })
    expect(prisma.productPublishFeishuSyncRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: ProductPublishFeishuSyncStatus.SUCCESS,
        totalCount: 1,
        successCount: 1,
        failedCount: 0,
        skippedCount: 0,
      }),
    })
  })

  it("更新已有店铺但不删除未出现在视图中的本地店铺", async () => {
    feishu.searchStoreRecords.mockResolvedValue([
      {
        recordId: "rec-1",
        fields: {
          店铺ID: 27826971599669,
          紫鸟店铺: "Amazon US",
          是否禁用: "是",
        },
      },
    ])
    prisma.productPublishStore.findUnique.mockResolvedValue({ id: 1 })

    await expect(service.syncFromFeishu()).resolves.toMatchObject({
      updated: 1,
      created: 0,
    })
    expect(prisma.productPublishStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ disabled: true }),
      })
    )
    expect(prisma.productPublishFeishuSyncRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: ProductPublishFeishuSyncAction.UPDATED }),
    })
    expect(prisma.productPublishStore).not.toHaveProperty("deleteMany")
  })

  it("新店铺会继承导入到全局目录的后续分类", async () => {
    feishu.searchStoreRecords.mockResolvedValue([
      { recordId: "rec-1", fields: { 店铺ID: "123", 紫鸟店铺: "新店铺" } },
    ])
    prisma.productPublishClassificationCatalog.findMany.mockResolvedValue([
      { code: "NOTEBOOK COMPUTER", name: "laptop", sortOrder: 0 },
      { code: "NEW CATEGORY", name: "New Category", sortOrder: 12 },
    ])
    prisma.productPublishStore.findUnique.mockResolvedValue(null)

    await service.syncFromFeishu()

    expect(prisma.productPublishStoreClassification.createMany).toHaveBeenCalledWith({
      data: [
        {
          storeId: 1,
          classification: "NOTEBOOK COMPUTER",
          classificationName: "laptop",
          sortOrder: 0,
        },
        {
          storeId: 1,
          classification: "NEW CATEGORY",
          classificationName: "New Category",
          sortOrder: 12,
        },
      ],
      skipDuplicates: true,
    })
  })

  it("逐条记录非法与重复店铺ID的跳过原因", async () => {
    feishu.searchStoreRecords.mockResolvedValue([
      { recordId: "bad", fields: { 店铺ID: "abc" } },
      { recordId: "first", fields: { 店铺ID: "123", 紫鸟店铺: "店铺1" } },
      { recordId: "duplicate", fields: { 店铺ID: "123", 紫鸟店铺: "店铺2" } },
    ])
    prisma.productPublishStore.findUnique.mockResolvedValue(null)

    await expect(service.syncFromFeishu()).resolves.toMatchObject({
      total: 3,
      created: 1,
      failed: 0,
      skipped: 2,
    })
    expect(prisma.productPublishStore.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.productPublishFeishuSyncRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feishuRecordId: "bad",
        status: ProductPublishFeishuSyncRecordStatus.SKIPPED,
        action: ProductPublishFeishuSyncAction.SKIPPED,
        message: expect.stringContaining("合法店铺ID"),
      }),
    })
    expect(prisma.productPublishFeishuSyncRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feishuRecordId: "duplicate",
        externalStoreId: "123",
        status: ProductPublishFeishuSyncRecordStatus.SKIPPED,
        message: expect.stringContaining("重复"),
      }),
    })
  })

  it("拒绝已发生精度风险的数值型店铺ID并提示飞书改为文本", async () => {
    feishu.searchStoreRecords.mockResolvedValue([
      { recordId: "unsafe", fields: { 店铺ID: Number.MAX_SAFE_INTEGER + 1 } },
    ])

    await expect(service.syncFromFeishu()).resolves.toMatchObject({
      status: ProductPublishFeishuSyncStatus.SKIPPED,
      total: 1,
      created: 0,
      failed: 0,
      skipped: 1,
    })
    expect(prisma.productPublishFeishuSyncRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feishuRecordId: "unsafe",
        status: ProductPublishFeishuSyncRecordStatus.SKIPPED,
        message: expect.stringContaining("安全整数"),
      }),
    })
    expect(prisma.productPublishStore.upsert).not.toHaveBeenCalled()
  })

  it("单条数据库失败会记录失败并继续同步后续记录", async () => {
    feishu.searchStoreRecords.mockResolvedValue([
      { recordId: "failed", fields: { 店铺ID: "123", 紫鸟店铺: "失败店铺" } },
      { recordId: "success", fields: { 店铺ID: "456", 紫鸟店铺: "成功店铺" } },
    ])
    prisma.productPublishStore.findUnique.mockResolvedValue(null)
    prisma.productPublishStore.upsert
      .mockRejectedValueOnce(new Error("数据库暂时不可用"))
      .mockResolvedValueOnce({ id: 2 })

    await expect(service.syncFromFeishu()).resolves.toMatchObject({
      status: ProductPublishFeishuSyncStatus.PARTIAL_FAILED,
      total: 2,
      created: 1,
      failed: 1,
      skipped: 0,
    })
    expect(prisma.productPublishStore.upsert).toHaveBeenCalledTimes(2)
    expect(prisma.productPublishFeishuSyncRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feishuRecordId: "failed",
        externalStoreId: "123",
        status: ProductPublishFeishuSyncRecordStatus.FAILED,
        action: null,
        message: "数据库暂时不可用",
      }),
    })
    expect(prisma.productPublishFeishuSyncRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: ProductPublishFeishuSyncStatus.PARTIAL_FAILED,
        totalCount: 2,
        successCount: 1,
        failedCount: 1,
        skippedCount: 0,
      }),
    })
  })

  it("飞书读取失败时把批次标记失败后继续抛出原错误", async () => {
    const error = new Error("飞书分页失败")
    feishu.searchStoreRecords.mockRejectedValue(error)

    await expect(service.syncFromFeishu()).rejects.toBe(error)
    expect(prisma.productPublishFeishuSyncRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: ProductPublishFeishuSyncStatus.FAILED,
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        errorMessage: "飞书分页失败",
      }),
    })
  })
})
