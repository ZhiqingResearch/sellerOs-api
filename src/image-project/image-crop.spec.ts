import sharp from "sharp"
import { ConflictException, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { createHash } from "crypto"
import { ImageCropService } from "./image-crop.service"
import { ImageProjectService } from "./image-project.service"

const dto = {
  idempotencyKey: "c64f5c10-828e-48c8-aabc-e5820a792846",
  sourceImageId: 101,
  url: "https://assets.example/image-project/crops/7/c64f5c10-828e-48c8-aabc-e5820a792846.png",
}
const requestHash = createHash("sha256")
  .update(JSON.stringify([3, 101, dto.url]))
  .digest("hex")
function setup(type = "PORTRAIT") {
  const source = {
    id: 101,
    taskId: 100,
    url: "https://cdn.example/finished.png",
    originalUrl: "https://cdn.example/gateway-original.png",
    task: {
      id: 100,
      type,
      model: "old-alias",
      presetCategory: type,
      presetOption: "四视角",
      prompt: "原提示词",
      promptConfig: { creation_type: "PORTRAIT" },
      viewConfig: { view: "front" },
      aspectRatio: "1:1",
      imageLabelBase: "来源图片",
      sourceJobId: "original-job",
      executionSpec: { modelPublicId: "ZQ-Image-2", form: { resolutionTier: "4K" } },
    },
  }
  const savedRow = {
    id: 501,
    generationMode: "CROP",
    deletedAt: null,
    projectDeletedAt: null,
    executionSpec: { cropRequestHash: requestHash },
  }
  const saved = {
    id: 501,
    userId: 7,
    model: "ZQ-Image-2",
    status: "SUCCESS",
    generationMode: "CROP",
    gatewayTaskId: null,
    type,
    generatedImages: [{ id: 601, url: dto.url, originalUrl: source.url, width: 800, height: 600 }],
  }
  const prisma = {
    $queryRaw: jest
      .fn<Promise<unknown[]>, [TemplateStringsArray, ...unknown[]]>()
      .mockResolvedValue([]),
    generatedImage: { findFirst: jest.fn().mockResolvedValue(source) },
    generationTask: { findUnique: jest.fn().mockResolvedValue(saved) },
    aiGatewayModel: {
      findMany: jest.fn().mockResolvedValue([{ publicId: "ZQ-Image-2", displayName: "图像模型" }]),
    },
    $transaction: jest.fn(),
  }
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 101 }]),
    generatedImage: { findFirst: jest.fn().mockResolvedValue(source) },
    generationTask: {
      create: jest
        .fn<Promise<{ id: number }>, [Prisma.GenerationTaskCreateArgs]>()
        .mockResolvedValue({ id: 501 }),
    },
  }
  prisma.$transaction.mockImplementation((fn: (value: typeof tx) => Promise<unknown>) => fn(tx))
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAyAAAAJY", "base64")
  const header = Buffer.alloc(33)
  png.copy(header)
  const spaces = {
    getPublicUrl: jest.fn((key: string) => `https://assets.example/${key}`),
    generateUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: "signed-put", publicUrl: dto.url }),
    getObjectMetadata: jest
      .fn()
      .mockResolvedValue({ contentType: "image/png", metadata: { "owner-id": "7" } }),
    downloadBuffer: jest.fn((_key: string, range?: string) => range ? Promise.resolve(header) : sharp({ create: { width: 800, height: 600, channels: 3, background: "white" } }).png().toBuffer()),
    uploadBuffer: jest.fn((_buffer, key: string) => Promise.resolve(`https://assets.example/${key}`)),
    deleteObject: jest.fn(),
  }
  const gateway = { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) }
  const projects = new ImageProjectService(prisma as never, gateway as never)
  const service = new ImageCropService(prisma as never, spaces as never, projects)
  return { service, prisma, tx, spaces, savedRow, saved, source }
}

describe("人像及批量改图裁剪保存", () => {
  it.each(["PORTRAIT", "GENERAL", "ECOMMERCE"])(
    "%s 新建独立成品，原图、原任务及扣费关联保持不变",
    async type => {
      const { service, tx, spaces, source } = setup(type)
      const before = structuredClone(source)
      const saved = await service.save(3, dto, 7)
      expect(saved).toMatchObject({
        id: 501,
        generationMode: "CROP",
        displayName: "图像模型",
        generatedImages: [{ id: 601, width: 800, height: 600, originalUrl: source.url }],
      })
      const data = tx.generationTask.create.mock.calls[0][0].data
      expect(data).toMatchObject({
        type,
        model: "ZQ-Image-2",
        status: "SUCCESS",
        n: 1,
        clientRequestId: `crop:${dto.idempotencyKey}`,
        directionIndex: 0,
        promptConfig: source.task.promptConfig,
        viewConfig: source.task.viewConfig,
        executionSpec: {
          kind: "IMAGE_CROP",
          derivation: { type: "CROP", sourceImageId: 101, sourceTaskId: 100 },
          sourceGeneration: { aspectRatio: "1:1", resolutionTier: "4K" },
        },
      })
      expect(data).not.toHaveProperty("sourceJobId")
      expect(data).not.toHaveProperty("gatewayTaskId")
      expect(data).not.toHaveProperty("deadlineAt")
      expect(data.generatedImages).toMatchObject({ create: { originalUrl: source.url } })
      expect(source).toEqual(before)
      expect(spaces.uploadBuffer).toHaveBeenCalledTimes(1)
      expect(spaces.deleteObject).not.toHaveBeenCalled()
    }
  )

  it("同键同请求重试返回首个任务，不重复读取上传对象或写库", async () => {
    const { service, prisma, savedRow, spaces } = setup()
    prisma.$queryRaw.mockResolvedValue([savedRow])
    await expect(service.save(3, dto, 7)).resolves.toMatchObject({ id: 501 })
    await expect(service.save(3, dto, 7)).resolves.toMatchObject({ id: 501 })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(spaces.getObjectMetadata).not.toHaveBeenCalled()
    const [, userId, key] = prisma.$queryRaw.mock.calls[0]
    expect([userId, key]).toEqual([7, `crop:${dto.idempotencyKey}`])
  })

  it.each([
    { projectId: 4, input: dto },
    { projectId: 3, input: { ...dto, sourceImageId: 102 } },
    { projectId: 3, input: { ...dto, url: dto.url.replace(".png", "-new.png") } },
  ])("同键换项目、来源或 URL 返回 409", async ({ projectId, input }) => {
    const { service, prisma, savedRow } = setup()
    prisma.$queryRaw.mockResolvedValue([savedRow])
    await expect(service.save(projectId, input, 7)).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it.each(["task", "project", "image"])("首次副本的 %s 被删除，旧键返回 409", async target => {
    const { service, prisma, savedRow, saved } = setup()
    prisma.$queryRaw.mockResolvedValue([
      {
        ...savedRow,
        deletedAt: target === "task" ? new Date() : null,
        projectDeletedAt: target === "project" ? new Date() : null,
      },
    ])
    if (target === "image")
      prisma.generationTask.findUnique.mockResolvedValue({ ...saved, generatedImages: [] })
    await expect(service.save(3, dto, 7)).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("新动作允许再存一份；数据库唯一冲突只回查已提交结果", async () => {
    const { service, prisma, tx, savedRow } = setup()
    await service.save(3, { ...dto, idempotencyKey: "430bf253-e97c-49fb-8bdc-f2e80931c690" }, 7)
    expect(tx.generationTask.create.mock.calls[0][0].data.clientRequestId).toBe(
      "crop:430bf253-e97c-49fb-8bdc-f2e80931c690"
    )
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([savedRow])
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" })
    )
    await expect(service.save(3, dto, 7)).resolves.toMatchObject({ id: 501 })
    expect(tx.generationTask.create).toHaveBeenCalledTimes(1)
  })

  it("来源须为本人当前平台同项目成功未删图片，错误来源不读取上传对象", async () => {
    const { service, prisma, spaces } = setup()
    prisma.generatedImage.findFirst.mockResolvedValue(null)
    await expect(service.save(3, dto, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.generatedImage.findFirst).toHaveBeenCalledWith({
      where: {
        id: 101,
        source: "platform",
        status: "SUCCESS",
        deletedAt: null,
        url: { not: null },
        task: {
          projectId: 3,
          userId: 7,
          source: "platform",
          deletedAt: null,
          project: { userId: 7, source: "platform", deletedAt: null },
        },
      },
    })
    expect(spaces.getObjectMetadata).not.toHaveBeenCalled()
  })

  it("事务内来源已删或保存失败时不返回成功，也不清理上传文件", async () => {
    const { service, tx, spaces } = setup()
    tx.$queryRaw.mockResolvedValue([])
    await expect(service.save(3, dto, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(tx.generationTask.create).not.toHaveBeenCalled()
    tx.$queryRaw.mockResolvedValue([{ id: 101 }])
    tx.generationTask.create.mockRejectedValue(new Error("database unavailable"))
    await expect(service.save(3, dto, 7)).rejects.toThrow("database unavailable")
    expect(spaces.deleteObject).not.toHaveBeenCalled()
  })

  it("凭证限定用户、PNG 与公开 ACL；旧车泰斗路径不能用于项目裁剪", async () => {
    const { service, spaces } = setup()
    await service.uploadUrl(7)
    expect(spaces.generateUploadUrl).toHaveBeenCalledWith({
      key: expect.stringMatching(/^image-project\/crops\/7\/[\da-f-]{36}\.png$/) as unknown,
      contentType: "image/png",
      acl: "public-read",
      metadata: { "owner-id": "7" },
    })
    await expect(
      service.save(3, { ...dto, url: dto.url.replace("image-project", "chetaidou") }, 7)
    ).rejects.toThrow("本人裁剪直传")
    expect(spaces.getObjectMetadata).not.toHaveBeenCalled()
  })
})
