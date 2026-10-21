/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import sharp from "sharp"
import { ChetaidouResultService } from "./chetaidou-result.service"
import { ChetaidouStorageService, stableHash } from "./chetaidou-storage.service"

const key = "b9be0889-6c64-4c61-8d72-2ca6c36b1298"
const dto = {
  idempotencyKey: key,
  sourceWidth: 1024,
  sourceHeight: 1024,
  annotatedBoxes: [
    { n: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.3, instruction: "修改背景", refImageNumbers: [] },
  ],
}

async function setup() {
  const bytes = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "white" },
  })
    .png()
    .toBuffer()
  const sourceTask: any = {
    id: "source",
    ownerId: 7,
    skuId: 1,
    imageId: 19,
    site: "amazon_us",
    snapshot: {
      settings: { site: "amazon_us" },
      models: { image: { publicId: "image", category: "CHETAIDOU_IMAGE" } },
      generation: { resolutionTier: "1K" },
      composition: { taskId: "old-compose", editPromptEn: "MUST NOT REUSE" },
    },
  }
  const taskRows: any[] = [],
    jobRows: any[] = [],
    importRows: any[] = [],
    poolRows: any[] = []
  const item = { id: 310, jobId: "source-job", status: "SUCCEEDED", fileKey: "private/source.png" }
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    imageGenItem: { findFirst: jest.fn().mockResolvedValue(item) },
    chetaidouTask: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.idempotencyKey
            ? (taskRows.find(t => t.idempotencyKey === where.idempotencyKey) ?? null)
            : sourceTask
        )
      ),
      create: jest.fn(({ data }: any) => {
        taskRows.push(data)
        return Promise.resolve(data)
      }),
    },
    imageGenJob: {
      create: jest.fn(({ data }: any) => {
        const job = { ...data, status: "QUEUED", items: [{ id: 502, idx: 0, status: "QUEUED" }] }
        jobRows.push(job)
        return Promise.resolve(job)
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) =>
        Promise.resolve(jobRows.find(j => j.id === where.id))
      ),
    },
    chetaidouResultImport: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          importRows.find(r => r.idempotencyKey === where.ownerId_idempotencyKey.idempotencyKey) ??
            null
        )
      ),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(importRows)),
      create: jest.fn(({ data }: any) => {
        importRows.push(data)
        return Promise.resolve(data)
      }),
    },
    poolImage: {
      create: jest.fn(({ data }: any) => {
        const row = { ...data, id: 80 }
        poolRows.push(row)
        return Promise.resolve(row)
      }),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          poolRows.find(
            p =>
              (where.id ? p.id === where.id : p.url === where.url) &&
              p.userId === where.userId &&
              (where.deletedAt === undefined || p.deletedAt == null)
          ) ?? null
        )
      ),
    },
    imageTemplateItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 501 }),
    },
    imageTemplate: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 77 }),
    },
    imageTemplateGroup: { upsert: jest.fn().mockResolvedValue({ id: 12 }) },
    poolGroup: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  db.$transaction = jest.fn(async (fn: any) => fn(db))
  const spaces = {
    downloadBuffer: jest.fn().mockResolvedValue(bytes),
    uploadBuffer: jest.fn().mockResolvedValue("https://example.com/durable.png"),
  }
  const storage = {
    validateImage: (b: Buffer) => new ChetaidouStorageService({} as never).validateImage(b),
    hostArtifact: jest.fn().mockResolvedValue(undefined),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  }
  const options = {
    resolveModel: jest.fn().mockResolvedValue({
      publicId: "image",
      gatewayConfig: {
        requestSchema: { request_schema: { type: "object", properties: {} } },
        detail: { facts: { modes: ["edit"] } },
      },
    }),
    assertUnchanged: jest.fn().mockResolvedValue(undefined),
  }
  const service = new ChetaidouResultService(
    db,
    spaces as never,
    storage as never,
    options as never
  )
  return { service, db, bytes, storage, spaces, taskRows, jobRows, importRows, poolRows, options }
}

describe("车泰斗成品操作", () => {
  it("重绘用成品和标注创建独立 GENERATE，不依赖草稿/组合；相同请求不重复创建", async () => {
    const s = await setup()
    const first = await s.service.inpaint(7, 310, dto, { buffer: s.bytes })
    expect(first).toMatchObject({
      sourceResultId: 310,
      intent: "INPAINT",
      items: [{ resultId: 502 }],
    })
    expect(s.taskRows[0]).toMatchObject({
      type: "GENERATE",
      rootTaskId: first.taskId,
      skuId: 1,
      imageId: 19,
    })
    expect(s.jobRows[0].request.sourceFileKey).toBe("private/source.png")
    expect(s.jobRows[0].request.referenceFileKeys).toHaveLength(1)
    expect(s.jobRows[0].request.prompt).not.toContain("MUST NOT REUSE")
    expect(s.jobRows[0].request.generation).toMatchObject({ targetWidth: 1024, targetHeight: 1024 })
    expect(await s.service.inpaint(7, 310, dto, { buffer: s.bytes })).toEqual(first)
    expect(s.db.imageGenJob.create).toHaveBeenCalledTimes(1)
  })
  it("错误尺寸、越权来源、非法框及参考编号拒绝，不上传附件", async () => {
    const s = await setup()
    await expect(
      s.service.inpaint(7, 310, { ...dto, sourceWidth: 100 }, { buffer: s.bytes })
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      s.service.inpaint(
        7,
        310,
        { ...dto, annotatedBoxes: [{ ...dto.annotatedBoxes[0], w: 1 }] },
        { buffer: s.bytes }
      )
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      s.service.inpaint(
        7,
        310,
        { ...dto, annotatedBoxes: [{ ...dto.annotatedBoxes[0], refImageNumbers: [1] }] },
        { buffer: s.bytes }
      )
    ).rejects.toBeInstanceOf(BadRequestException)
    s.db.imageGenItem.findFirst.mockResolvedValue(null)
    await expect(s.service.inpaint(8, 310, dto, { buffer: s.bytes })).rejects.toBeInstanceOf(
      NotFoundException
    )
    expect(s.storage.hostArtifact).not.toHaveBeenCalled()
  })
  it("同幂等键重试返回原结果，异参数拒绝；素材副本为持久 URL", async () => {
    const s = await setup()
    const body = { idempotencyKey: key, name: "车泰斗图" }
    expect(await s.service.saveMaterial(7, 310, body)).toEqual({ resultId: 310, poolImageId: 80 })
    expect(s.poolRows[0]).toMatchObject({
      url: "https://example.com/durable.png",
      sourceMeta: { resultId: 310, width: 1024 },
    })
    expect(await s.service.saveMaterial(7, 310, body)).toEqual({ resultId: 310, poolImageId: 80 })
    expect(s.spaces.uploadBuffer).toHaveBeenCalledTimes(1)
    await expect(
      s.service.saveMaterial(7, 310, { ...body, name: "不同名字" })
    ).rejects.toBeInstanceOf(ConflictException)
    expect(s.db.poolImage.create).toHaveBeenCalledTimes(1)
    expect(s.db.chetaidouResultImport.create).toHaveBeenCalledTimes(1)
  })
  it("新幂等键重复入池返回 409 已在素材池中，不改原素材、不新增入池记录", async () => {
    const s = await setup()
    const body = { idempotencyKey: key, name: "原名称" }
    await s.service.saveMaterial(7, 310, body)
    s.spaces.uploadBuffer.mockResolvedValueOnce("https://example.com/duplicate-copy.png")
    await expect(
      s.service.saveMaterial(7, 310, {
        ...body,
        idempotencyKey: "c2e6fe37-293f-49d0-a463-62668515d7f9",
        name: "新名称",
        tags: ["新标签"],
      })
    ).rejects.toMatchObject({
      status: 409,
      response: { statusCode: 409, message: "已在素材池中" },
    })
    expect(s.db.poolImage.create).toHaveBeenCalledTimes(1)
    expect(s.db.chetaidouResultImport.create).toHaveBeenCalledTimes(1)
    expect(s.poolRows[0]).toMatchObject({ name: "原名称", tags: [] })
    expect(s.storage.deleteObject).toHaveBeenCalledTimes(1)
  })
  it("已入池素材删除后允许新幂等键再次保存，旧键仍返回原结果", async () => {
    const s = await setup()
    const body = { idempotencyKey: key, name: "原名称" }
    const first = await s.service.saveMaterial(7, 310, body)
    s.poolRows[0].deletedAt = new Date()
    s.db.poolImage.create.mockResolvedValueOnce({ id: 81 })
    expect(
      await s.service.saveMaterial(7, 310, {
        ...body,
        idempotencyKey: "c2e6fe37-293f-49d0-a463-62668515d7f9",
      })
    ).toEqual({ resultId: 310, poolImageId: 81 })
    expect(await s.service.saveMaterial(7, 310, body)).toEqual(first)
    expect(s.db.poolImage.create).toHaveBeenCalledTimes(2)
    expect(s.db.chetaidouResultImport.create).toHaveBeenCalledTimes(2)
  })
  it("新建和追加都写现有个人模板，源图和副本独立且保留来源元信息", async () => {
    const s = await setup()
    expect(
      await s.service.saveTemplate(7, 310, {
        idempotencyKey: key,
        mode: "CREATE",
        name: "新模板",
        groupName: "商品",
      })
    ).toEqual({ resultId: 310, templateId: 77, templateItemId: 501 })
    expect(s.db.imageTemplateItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refImageUrl: "https://example.com/durable.png",
          sourceMeta: expect.objectContaining({ resultId: 310, modelPublicId: "image" }),
        }),
      })
    )
    s.db.imageTemplate.findFirst.mockResolvedValue({ id: 88, userId: 7, isSystem: false })
    expect(
      await s.service.saveTemplate(7, 310, {
        idempotencyKey: "c2e6fe37-293f-49d0-a463-62668515d7f9",
        mode: "APPEND",
        templateId: 88,
      })
    ).toMatchObject({ templateId: 88 })
    expect(s.db.imageGenJob.create).not.toHaveBeenCalled()
  })
  it("同键不同标注字节拒绝，不重新调用或上传", async () => {
    const s = await setup()
    await s.service.inpaint(7, 310, dto, { buffer: s.bytes })
    const changed = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: "black" },
    })
      .png()
      .toBuffer()
    await expect(s.service.inpaint(7, 310, dto, { buffer: changed })).rejects.toBeInstanceOf(
      ConflictException
    )
    expect(s.db.imageGenJob.create).toHaveBeenCalledTimes(1)
  })
  it("不可写目标在公开转存前拒绝", async () => {
    const s = await setup()
    await expect(
      s.service.saveTemplate(7, 310, { idempotencyKey: key, mode: "APPEND", templateId: 99 })
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      s.service.saveMaterial(7, 310, { idempotencyKey: key, name: "图", groupId: 99 })
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(s.spaces.uploadBuffer).not.toHaveBeenCalled()
  })
  it.each(["P2002", "duplicate"])("并发同键冲突退出事务后返回原结果：%s", async conflict => {
    const s = await setup()
    const originalResponse = { resultId: 310, poolImageId: 81 }
    s.db.$transaction.mockImplementationOnce(async () => {
      s.importRows.push({
        idempotencyKey: key,
        requestHash: stableHash({
          action: "MATERIAL",
          resultId: 310,
          idempotencyKey: key,
          name: "图",
        }),
        response: originalResponse,
      })
      if (conflict === "duplicate") throw new ConflictException("已在素材池中")
      throw new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "6",
      })
    })
    expect(await s.service.saveMaterial(7, 310, { idempotencyKey: key, name: "图" })).toEqual(
      originalResponse
    )
    expect(s.storage.deleteObject).toHaveBeenCalledTimes(1)
  })
})
