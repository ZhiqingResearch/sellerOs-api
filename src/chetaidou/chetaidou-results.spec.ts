import { ChetaidouResultService } from "./chetaidou-result.service"
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { ChetaidouImageOptionsService } from "./chetaidou-image-options.service"
import { ChetaidouStorageService } from "./chetaidou-storage.service"
import { ChetaidouController } from "./chetaidou.controller"
import { ChetaidouService } from "./chetaidou.service"

function setupStore() {
  const jobs: any[] = [
    {
      id: "job-a",
      businessTaskId: "task-a",
      userId: 7,
      businessType: "CHETAIDOU",
      status: "COMPLETED",
    },
    {
      id: "job-b",
      businessTaskId: "task-b",
      userId: 7,
      businessType: "CHETAIDOU",
      status: "COMPLETED",
    },
    { id: "foreign", userId: 8, businessType: "CHETAIDOU" },
    { id: "creative", userId: 7, businessType: "IMAGE_CREATIVE" },
  ]
  const tasks: any[] = jobs.map((job, index) => ({
    id: job.businessTaskId ?? job.id,
    rootTaskId: job.businessTaskId ?? job.id,
    imageGenJobId: job.id,
    ownerId: job.userId,
    skuId: 1,
    imageId: 19,
    type: "GENERATE",
    operation: "PRIMARY",
    input: {},
    snapshot: { models: { image: { publicId: "image" } } },
    createdAt: new Date(index + 1),
    updatedAt: new Date(index + 1),
  }))
  const items: any[] = jobs.map((job, index) => ({
    id: 101 + index,
    jobId: job.id,
    idx: index,
    status: "SUCCEEDED",
    fileKey: `${job.id}/output.${index ? "jpg" : "png"}`,
    mime: index ? "image/jpeg" : "image/png",
    width: 1024,
    height: 1024,
    deletedAt: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
  }))
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (value === undefined) return true
      if (key === "OR") return value.some((condition: any) => matches(row, condition))
      if (key === "job")
        return matches(
          jobs.find(job => job.id === row.jobId),
          value
        )
      if (value && typeof value === "object") {
        if ("path" in value)
          return (
            value.path
              .slice(2)
              .split(".")
              .reduce((json: any, key: string) => json?.[key], row[key]) === value.equals
          )
        if ("in" in value) return value.in.includes(row[key])
        if ("not" in value) return row[key] !== value.not
      }
      return row[key] === value
    })
  const db: any = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    imageGenItem: {
      count: jest.fn(async ({ where }: any) => items.filter(item => matches(item, where)).length),
      findMany: jest.fn(async ({ where, include, skip = 0, take = items.length }: any) =>
        items
          .filter(item => matches(item, where))
          .slice(skip, skip + take)
          .map(item => ({
            ...item,
            ...(include?.job ? { job: { ...jobs.find(job => job.id === item.jobId) } } : {}),
          }))
      ),
      findUnique: jest.fn(
        async ({ where }: any) => items.find(item => matches(item, where)) ?? null
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const selected = items.filter(item => matches(item, where))
        for (const item of selected) Object.assign(item, data, { updatedAt: new Date() })
        return { count: selected.length }
      }),
    },
    imageGenJob: {
      findMany: jest.fn(async ({ where, include }: any) =>
        jobs
          .filter(job => matches(job, where))
          .map(job => ({
            ...job,
            items: items.filter(
              item => item.jobId === job.id && matches(item, include.items.where)
            ),
          }))
      ),
      findUnique: jest.fn(async ({ where }: any) => {
        const job = jobs.find(job => matches(job, where))
        return job ? { ...job, items: items.filter(item => item.jobId === job.id) } : null
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          jobs.find(job => matches(job, where)),
          data
        )
      ),
    },
    chetaidouTask: {
      findMany: jest.fn(async ({ where }: any) => tasks.filter(task => matches(task, where))),
      findUnique: jest.fn(
        async ({ where }: any) => tasks.find(task => matches(task, where)) ?? null
      ),
      findFirst: jest.fn(
        async ({ where }: any) => tasks.find(task => matches(task, where)) ?? null
      ),
      create: jest.fn(async ({ data }: any) => {
        tasks.push(data)
        return data
      }),
    },
    chetaidouCall: { count: jest.fn().mockResolvedValue(0) },
    chetaidouImage: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 19, number: "NO7", title: "母版", fileKey: "master.png" }]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 19, number: "NO7", title: "母版", fileKey: "master.png" }),
    },
    chetaidouSku: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, code: "CS1plus", enabled: true }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  db.$transaction = jest.fn(async (action: any) => {
    if (Array.isArray(action)) return Promise.all(action)
    const before = structuredClone(items)
    try {
      return await action(db)
    } catch (error) {
      items.splice(0, items.length, ...before)
      throw error
    }
  })
  return { db, items, jobs, tasks }
}

describe("车泰斗预览墙批量下载与软删除", () => {
  let state: ReturnType<typeof setupStore>
  let service: ChetaidouService
  const storage = {
    signDownload: jest.fn(async (key: string) => `signed:${key}`),
    downloadFilename: jest.fn((parts: Parameters<ChetaidouStorageService["downloadFilename"]>[0]) =>
      ChetaidouStorageService.prototype.downloadFilename(parts)
    ),
    deleteObject: jest.fn(),
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    state = setupStore()
    const module = await Test.createTestingModule({
      providers: [
        { provide: ChetaidouResultService, useValue: {} },
        ChetaidouService,
        { provide: PrismaService, useValue: state.db },
        { provide: ChetaidouStorageService, useValue: storage },
        {
          provide: ChetaidouContextService,
          useValue: { requestHash: jest.fn().mockReturnValue("hash") },
        },
        { provide: ChetaidouBillingService, useValue: { assertModelsReady: jest.fn() } },
        { provide: ChetaidouImageOptionsService, useValue: { assertRetryModel: jest.fn() } },
      ],
    }).compile()
    service = module.get(ChetaidouService)
  })

  it("两个接口挂在 SKU 下，POST 成功返回 200", () => {
    for (const [method, path] of [
      ["batchDownloadResults", "skus/:skuId/results/batch-download"],
      ["batchDeleteResults", "skus/:skuId/results/batch-delete"],
    ] as const) {
      const handler = Object.getOwnPropertyDescriptor(ChetaidouController.prototype, method)!.value
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path)
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200)
    }
  })

  it("裁剪独立归档可分页、下载、删除，生成任务中心隐藏且不暴露内部元数据", async () => {
    state.items[0].url = "https://assets.example/crop.png"
    state.tasks[0].type = "CROP"
    state.tasks[0].status = "SUCCEEDED"
    state.tasks[0].site = "amazon_us"
    state.tasks[0].snapshot.generation = { count: 4 }
    state.items[0].gatewayImage = {
      actual: { width: 800, height: 600, format: "png" },
      derivation: { type: "CROP", sourceResultId: 99 },
    }
    state.db.chetaidouImage.findFirst = jest.fn().mockResolvedValue({ number: "NO7" })
    const wall = await service.listResults(7, 1, { page: 1, pageSize: 1, site: "amazon_us" })
    expect(wall.total).toBe(1)
    expect(wall.items[0]).toMatchObject({
      resultId: 101,
      url: "https://assets.example/crop.png",
      generation: null,
      originalUrl: null,
      derivation: { type: "CROP", sourceResultId: 99 },
    })
    expect(wall.items[0]).not.toHaveProperty("fileKey")
    expect((await service.listTasks(7, { page: 1, pageSize: 20 })).items.map(t => t.id)).toEqual([
      "task-b",
      "creative",
    ])
    expect((await service.listTasks(7, { type: "CROP", page: 1, pageSize: 20 })).total).toBe(0)
    expect((await service.getTask(7, "task-a")).items).toMatchObject([
      { resultId: 101, derivation: { type: "CROP", sourceResultId: 99 } },
    ])
    expect(await service.downloadResult(7, 101)).toMatchObject({
      filename: "CS1plus_NO7_task-a_1.png",
    })
    expect(await service.batchDownloadResults(7, 1, [101])).toMatchObject({ count: 1 })
    await service.batchDeleteResults(7, 1, [101])
    expect(
      (await service.listResults(7, 1, { page: 1, pageSize: 20 })).items.map(t => t.resultId)
    ).toEqual([102])
    expect(state.items[1].deletedAt).toBeNull()
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  it("站点和母版筛选先于分页，只签名当前页且不查询整批图片", async () => {
    state.tasks[0].site = "amazon_de"
    state.tasks[1].site = "amazon_us"
    const filtered = await service.listResults(7, 1, {
      page: 1,
      pageSize: 1,
      site: "amazon_de",
      imageId: 19,
    })
    expect(filtered.total).toBe(1)
    expect(filtered.items.map(row => row.resultId)).toEqual([101])
    expect(state.db.chetaidouTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerId: 7,
          skuId: 1,
          imageId: 19,
          OR: [
            { site: "amazon_de" },
            { site: null, snapshot: { path: "$.settings.site", equals: "amazon_de" } },
          ],
        }),
      })
    )
    expect(state.db.imageGenItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 1 })
    )
    expect(state.db.imageGenJob.findMany).not.toHaveBeenCalled()
    expect(state.db.chetaidouTask.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      imageGenJobId: true,
    })
    expect(storage.signDownload).toHaveBeenCalledTimes(2)
    storage.signDownload.mockClear()
    const page = await service.listResults(7, 1, { page: 2, pageSize: 1 })
    expect(page.total).toBe(2)
    expect(page.items.map(row => row.resultId)).toEqual([102])
    expect(storage.signDownload).toHaveBeenCalledTimes(2)
    storage.signDownload.mockClear()
    const empty = await service.listResults(7, 1, { page: 1, pageSize: 20, imageId: 999 })
    expect(empty.total).toBe(0)
    expect(storage.signDownload).not.toHaveBeenCalled()
  })

  it.each(["original", "amazon_us"])(
    "%s 筛选包含站点列为空的旧任务，非空列优先于快照",
    async site => {
      state.tasks[0].site = null
      state.tasks[0].snapshot.settings = { site }
      state.tasks[1].site = "amazon_de"
      state.tasks[1].snapshot.settings = { site }
      state.tasks[2].site = null
      state.tasks[2].snapshot.settings = { site }
      const legacy = await service.listResults(7, 1, { site, page: 1, pageSize: 60 })
      expect(legacy.total).toBe(1)
      expect(legacy.items.map(row => [row.resultId, row.site])).toEqual([[101, site]])
      const history = await service.listTasks(7, { skuId: 1, site, page: 1, pageSize: 60 })
      expect(history.total).toBe(1)
      expect(history.items.map(row => [row.id, row.site])).toEqual([["task-a", site]])

      state.tasks[0].site = site
      state.tasks[0].snapshot.settings.site = "amazon_de"
      const current = await service.listResults(7, 1, { site, page: 1, pageSize: 60 })
      expect(current.total).toBe(1)
      expect(current.items.map(row => [row.resultId, row.site])).toEqual([[101, site]])
    }
  )

  it("预览墙返回原生成质量；失败图重试完整复用冻结质量", async () => {
    const generation = {
      count: 1,
      quality: "hd",
      resolution: "2k",
      resolutionTier: "2K",
      aspectRatio: "1:1",
      providerDefaults: {},
    }
    state.tasks[0].snapshot.generation = generation
    state.jobs[0].request = { generation }
    const wall = await service.listResults(7, 1, { page: 1, pageSize: 20 })
    expect(wall.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resultId: 101,
          generation: expect.objectContaining({ quality: "hd" }),
        }),
      ])
    )
    expect((wall.items.find((i: any) => i.resultId === 101) as any).generation).not.toHaveProperty(
      "providerDefaults"
    )
    state.items[0].status = "FAILED"
    const result = await service.retryTask(7, "task-a", {
      idempotencyKey: "retry-quality",
      resultIds: [101],
    })
    const retry = state.tasks.find(t => t.id === result.taskId)
    expect(retry.snapshot).toEqual(state.tasks[0].snapshot)
    expect(retry.snapshot.generation.quality).toBe("hd")
    expect(state.jobs[0].request.generation.quality).toBe("hd")
  })

  it("任务详情与预览墙返回原图签名，历史结果兼容且不暴露私有 key", async () => {
    state.items[0].gatewayImage = {
      nativeWidth: 848,
      nativeHeight: 1264,
      original: {
        callId: "call-a",
        fileKey: "job-a/original.png",
        mime: "image/png",
        width: 848,
        height: 1264,
      },
    }
    const wall = await service.listResults(7, 1, { page: 1, pageSize: 20 })
    expect(wall.items[0]).toMatchObject({
      url: "signed:job-a/output.png",
      originalUrl: "signed:job-a/original.png",
      generationMeta: { original: { width: 848, height: 1264, mime: "image/png" } },
    })
    expect(wall.items[0].generationMeta?.original).not.toHaveProperty("fileKey")
    expect(wall.items[0].generationMeta?.original).not.toHaveProperty("callId")
    expect(wall.items[1].originalUrl).toBeNull()
    expect((await service.getTask(7, "task-a")).items).toMatchObject([
      { resultId: 101, originalUrl: "signed:job-a/original.png" },
    ])
    storage.signDownload.mockClear()
    const withoutUrls = await service.projectTask(state.tasks[0], undefined, false)
    expect(withoutUrls.items).toMatchObject([{ originalUrl: null }])
    expect(storage.signDownload).not.toHaveBeenCalled()
    await service.batchDeleteResults(7, 1, [101])
    storage.signDownload.mockClear()
    expect((await service.getTask(7, "task-a")).items).toMatchObject([
      { resultId: 101, originalUrl: null },
    ])
    expect(storage.signDownload).not.toHaveBeenCalled()
  })

  it("跨生成批次下载保持请求顺序、真实 MIME 文件名和十分钟时效", async () => {
    const result = await service.batchDownloadResults(7, 1, [102, 101])
    expect(result.count).toBe(2)
    expect(result.items).toEqual([
      {
        resultId: 102,
        url: "signed:job-b/output.jpg",
        filename: "CS1plus_NO7_task-b_2.jpg",
        expiresAt: result.expiresAt,
      },
      {
        resultId: 101,
        url: "signed:job-a/output.png",
        filename: "CS1plus_NO7_task-a_1.png",
        expiresAt: result.expiresAt,
      },
    ])
    expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(590_000)
    expect(storage.signDownload).toHaveBeenCalledWith(
      "job-a/output.png",
      600,
      result.items[1].filename
    )
  })

  it.each([103, 104, 999])("外人、通用创作或不存在的 ID %i 整批拒绝，不签名或删除", async id => {
    for (const operation of [
      service.batchDownloadResults.bind(service),
      service.batchDeleteResults.bind(service),
    ]) {
      await expect(operation(7, 1, [101, id])).rejects.toMatchObject({
        status: 404,
        response: { code: "RESULT_NOT_FOUND" },
      })
    }
    expect(storage.signDownload).not.toHaveBeenCalled()
    expect(state.db.imageGenItem.updateMany).not.toHaveBeenCalled()
  })

  it("同用户其他 SKU 的结果不可混用", async () => {
    state.tasks[1].skuId = 2
    await expect(service.batchDownloadResults(7, 1, [101, 102])).rejects.toMatchObject({
      status: 404,
    })
    await expect(service.batchDeleteResults(7, 1, [101, 102])).rejects.toMatchObject({
      status: 404,
    })
    expect(storage.signDownload).not.toHaveBeenCalled()
    expect(state.db.$transaction).not.toHaveBeenCalled()
  })

  it.each(["FAILED", "QUEUED", "UNKNOWN", "DELIVERY_PENDING", "CANCELLED"])(
    "下载包含 %s 时整批失败",
    async status => {
      state.items[1].status = status
      await expect(service.batchDownloadResults(7, 1, [101, 102])).rejects.toMatchObject({
        status: 400,
        response: { code: "RESULT_NOT_DOWNLOADABLE" },
      })
      expect(storage.signDownload).not.toHaveBeenCalled()
    }
  )

  it("成功但文件未交付不可下载", async () => {
    state.items[1].fileKey = null
    await expect(service.batchDownloadResults(7, 1, [102])).rejects.toMatchObject({ status: 400 })
  })

  it("删除只标记本人的终态结果，保留文件、状态、任务、批次和计费账本；重复删除幂等", async () => {
    state.items[1].status = "FAILED"
    const before = structuredClone({ items: state.items, jobs: state.jobs, tasks: state.tasks })
    expect(await service.batchDeleteResults(7, 1, [102, 101])).toEqual({
      success: true,
      requestedCount: 2,
      removedCount: 2,
      alreadyRemovedCount: 0,
      resultIds: [102, 101],
    })
    expect(state.db.$queryRaw.mock.calls.map((call: any[]) => call[1])).toEqual(["job-a", "job-b"])
    expect(state.items.slice(0, 2).every(item => item.deletedAt instanceof Date)).toBe(true)
    for (const item of state.items) {
      const original = before.items.find(row => row.id === item.id)!
      expect(item).toMatchObject({ status: original.status, fileKey: original.fileKey })
    }
    expect(state.items[2].deletedAt).toBeNull()
    expect(state.jobs).toEqual(before.jobs)
    expect(state.tasks).toEqual(before.tasks)
    expect(storage.deleteObject).not.toHaveBeenCalled()
    expect(await service.batchDeleteResults(7, 1, [101, 102])).toMatchObject({
      removedCount: 0,
      alreadyRemovedCount: 2,
    })
    expect(state.db.imageGenItem.updateMany).toHaveBeenCalledTimes(1)
  })

  it("已取消的结果可以删除", async () => {
    state.items[0].status = "CANCELLED"
    expect(await service.batchDeleteResults(7, 1, [101])).toMatchObject({ removedCount: 1 })
  })

  it.each(["QUEUED", "RUNNING", "SETTLING", "DELIVERY_PENDING", "UNKNOWN"])(
    "%s 不可删除且不会部分删除其他图片",
    async status => {
      state.items[1].status = status
      await expect(service.batchDeleteResults(7, 1, [101, 102])).rejects.toMatchObject({
        status: 409,
        response: { code: "RESULT_NOT_REMOVABLE" },
      })
      expect(state.items.every(item => !item.deletedAt)).toBe(true)
      expect(state.db.imageGenItem.updateMany).not.toHaveBeenCalled()
    }
  )

  it("终态席位仍有待核对调用时不可删除", async () => {
    state.items[0].status = "FAILED"
    state.db.chetaidouCall.count.mockResolvedValue(1)
    await expect(service.batchDeleteResults(7, 1, [101])).rejects.toMatchObject({ status: 409 })
    expect(state.db.imageGenItem.updateMany).not.toHaveBeenCalled()
  })

  it("锁定后重新检查状态，抢先重试的图片不可删除", async () => {
    state.items[0].status = "FAILED"
    state.db.$queryRaw.mockImplementationOnce(async () => {
      state.items[0].status = "QUEUED"
      return []
    })
    await expect(service.batchDeleteResults(7, 1, [101])).rejects.toMatchObject({ status: 409 })
    expect(state.db.imageGenItem.updateMany).not.toHaveBeenCalled()
  })

  it("条件更新不完整时整事务回滚，不返回部分删除成功", async () => {
    state.db.imageGenItem.updateMany.mockImplementationOnce(async () => {
      state.items[0].deletedAt = new Date()
      return { count: 1 }
    })
    await expect(service.batchDeleteResults(7, 1, [101, 102])).rejects.toMatchObject({
      status: 409,
      response: { code: "RESULT_STATE_CHANGED" },
    })
    expect(state.items.every(item => !item.deletedAt)).toBe(true)
  })

  it("删除后预览墙分页剔除结果，单张/批量下载拒绝，任务历史仍保留进度", async () => {
    await service.batchDeleteResults(7, 1, [101])
    const wall = await service.listResults(7, 1, { page: 1, pageSize: 1 })
    expect(wall.total).toBe(1)
    expect(wall.items).toMatchObject([{ resultId: 102 }])
    await expect(service.downloadResult(7, 101)).rejects.toMatchObject({ status: 404 })
    await expect(service.batchDownloadResults(7, 1, [101])).rejects.toMatchObject({ status: 404 })
    const task = await service.getTask(7, "task-a")
    expect(task).toMatchObject({
      progress: { total: 1, succeeded: 1 },
      items: [{ resultId: 101, url: null, deletedAt: expect.any(Date) }],
    })
  })

  it("显式重试已删除结果拒绝，默认重试跳过已删除失败位", async () => {
    state.items[0].status = "FAILED"
    state.items.push({ ...state.items[0], id: 105, idx: 4, deletedAt: new Date() })
    await expect(
      service.retryTask(7, "task-a", { idempotencyKey: "retry-deleted", resultIds: [105] })
    ).rejects.toMatchObject({ response: { code: "RESULT_REMOVED" } })
    await service.retryTask(7, "task-a", { idempotencyKey: "retry-visible" })
    expect(state.items.find(item => item.id === 101).status).toBe("QUEUED")
    expect(state.items.find(item => item.id === 105).status).toBe("FAILED")
    expect(state.db.imageGenItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [101] }, status: "FAILED", deletedAt: null },
      })
    )
  })

  it("重试读取后抢先删除，条件认领失败且不创建新任务", async () => {
    state.items[0].status = "FAILED"
    state.db.$queryRaw.mockImplementationOnce(async () => {
      state.items[0].deletedAt = new Date()
      return []
    })
    await expect(
      service.retryTask(7, "task-a", { idempotencyKey: "racing-retry" })
    ).rejects.toMatchObject({ status: 409 })
    expect(state.db.chetaidouTask.create).not.toHaveBeenCalled()
  })
})
