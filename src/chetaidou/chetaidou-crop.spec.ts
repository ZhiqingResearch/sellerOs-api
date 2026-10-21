import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { stableHash } from "./chetaidou-storage.service"
import { ChetaidouService } from "./chetaidou.service"

const key = "c64f5c10-828e-48c8-aabc-e5820a792846"
const url = "https://assets.example/chetaidou/crops/7/c64f5c10-828e-48c8-aabc-e5820a792846.png"
const source = {
  id: 101,
  jobId: "original-job",
  deletedAt: null,
  status: "SUCCEEDED",
  fileKey: "source.png",
  gatewayImage: {
    original: {
      callId: "old-call",
      fileKey: "original.png",
      width: 400,
      height: 300,
      mime: "image/png",
    },
  },
}
const sourceTask = {
  id: "original-task",
  ownerId: 7,
  skuId: 1,
  imageId: 19,
  imageGenJobId: "original-job",
  type: "GENERATE",
  adjustmentId: null,
  site: "amazon_us",
  input: { compositionTaskId: "original-composition" },
  snapshot: { models: { image: { publicId: "retired-model" } }, generation: { count: 4 } },
}
function setup() {
  const archived = {
    ...sourceTask,
    id: "archive",
    type: "CROP",
    imageGenJobId: "crop-job",
    requestHash: stableHash({ action: "save-crop", resultId: 101, url }),
  }
  const db = {
    chetaidouTask: {
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(sourceTask),
      create: jest
        .fn<
          Prisma.ChetaidouTaskUncheckedCreateInput,
          [{ data: Prisma.ChetaidouTaskUncheckedCreateInput }]
        >()
        .mockImplementation(({ data }) => data),
    },
    imageGenItem: { findFirst: jest.fn().mockResolvedValue(source) },
    imageGenJob: {
      create: jest.fn<Promise<void>, [{ data: Prisma.ImageGenJobUncheckedCreateInput }]>(),
    },
    chetaidouSku: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
  db.$transaction.mockImplementation((action: (tx: typeof db) => Promise<unknown>) => action(db))
  const storage = {
    inspectCropPng: jest.fn().mockResolvedValue({
      fileKey: "chetaidou/crops/7/upload.png",
      mime: "image/png",
      width: 12,
      height: 8,
    }),
    createCropUpload: jest.fn().mockResolvedValue({ uploadUrl: "signed-put", publicUrl: url }),
    hostArtifact: jest.fn(),
    deleteObject: jest.fn(),
  }
  const billing = { assertModelsReady: jest.fn() }
  const service = new ChetaidouService(
    db as never,
    {} as never,
    storage as never,
    billing as never,
    {} as never
  )
  const projection = jest
    .spyOn(service, "listResults")
    .mockResolvedValue({ total: 1, page: 1, pageSize: 1, items: [{ resultId: 501, url }] as never })
  return { service, db, storage, billing, archived, projection }
}

describe("车泰斗前端直传裁剪成品保存", () => {
  it("公开直传凭证绑定本人，后端不上传文件、不检查模型或余额", async () => {
    const { service, storage, billing, db } = setup()
    await expect(service.cropUploadUrl(7)).resolves.toEqual({
      uploadUrl: "signed-put",
      publicUrl: url,
    })
    expect(storage.createCropUpload).toHaveBeenCalledWith(7)
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(billing.assertModelsReady).not.toHaveBeenCalled()
  })

  it("保存已上传 URL 和实际尺寸，独立归档，不重新转存或改变来源", async () => {
    const { service, db, storage, billing } = setup()
    const before = structuredClone(source)
    await expect(service.saveCrop(7, 101, url, key)).resolves.toMatchObject({ resultId: 501, url })
    expect(storage.inspectCropPng).toHaveBeenCalledWith(7, url)
    expect(db.chetaidouTask.create.mock.calls[0][0]).toMatchObject({
      data: {
        type: "CROP",
        status: "SUCCEEDED",
        idempotencyKey: key,
        skuId: 1,
        site: "amazon_us",
        input: { sourceResultId: 101, url, compositionTaskId: "original-composition" },
      },
    })
    expect(db.imageGenJob.create.mock.calls[0][0]).toMatchObject({
      data: {
        businessType: "CHETAIDOU",
        kind: "CROP",
        status: "COMPLETED",
        items: {
          create: {
            idx: 0,
            status: "SUCCEEDED",
            url,
            fileKey: "chetaidou/crops/7/upload.png",
            width: 12,
            height: 8,
            gatewayImage: {
              actual: { width: 12, height: 8, format: "png" },
              derivation: { type: "CROP", sourceResultId: 101 },
              original: source.gatewayImage.original,
            },
          },
        },
      },
    })
    expect(source).toEqual(before)
    expect(billing.assertModelsReady).not.toHaveBeenCalled()
    expect(storage.hostArtifact).not.toHaveBeenCalled()
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  it("历史没有原图也可保存公开成品", async () => {
    const { service, db } = setup()
    db.imageGenItem.findFirst.mockResolvedValue({ ...source, gatewayImage: null } as never)
    await service.saveCrop(7, 101, url, key)
    expect(db.imageGenJob.create.mock.calls[0][0].data.items?.create).toEqual(
      expect.objectContaining({
        gatewayImage: {
          actual: { width: 12, height: 8, format: "png" },
          derivation: { type: "CROP", sourceResultId: 101 },
        },
      })
    )
  })

  it("重复请求返回首次结果；同键改 URL 或来源冲突", async () => {
    const { service, db, storage, archived } = setup()
    db.chetaidouTask.findFirst.mockReset().mockResolvedValue(archived)
    await service.saveCrop(7, 101, url, key)
    await service.saveCrop(7, 101, url, key)
    await expect(
      service.saveCrop(7, 101, url.replace(".png", "-other.png"), key)
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(service.saveCrop(7, 102, url, key)).rejects.toBeInstanceOf(ConflictException)
    expect(storage.inspectCropPng).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("并发唯一冲突回滚后重查，不删除前端上传的文件", async () => {
    const { service, db, storage, archived } = setup()
    db.chetaidouTask.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sourceTask)
      .mockResolvedValueOnce(archived)
    db.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" })
    )
    await expect(service.saveCrop(7, 101, url, key)).resolves.toMatchObject({ resultId: 501 })
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  it("来源非本人或保存期间删除时拒绝，不建立结果", async () => {
    const { service, db, storage } = setup()
    db.imageGenItem.findFirst.mockResolvedValueOnce(null)
    await expect(service.saveCrop(7, 101, url, key)).rejects.toBeInstanceOf(NotFoundException)
    expect(storage.inspectCropPng).not.toHaveBeenCalled()
    const race = setup()
    race.db.imageGenItem.findFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(null)
    await expect(race.service.saveCrop(7, 101, url, key)).rejects.toBeInstanceOf(NotFoundException)
    expect(race.db.imageGenJob.create).not.toHaveBeenCalled()
    expect(race.storage.deleteObject).not.toHaveBeenCalled()
  })

  it("上传未完成或落库失败保留已上传地址，不返回成功结果", async () => {
    const { service, storage, projection, db } = setup()
    storage.inspectCropPng.mockRejectedValue(new BadRequestException("尚未上传完成"))
    await expect(service.saveCrop(7, 101, url, key)).rejects.toBeInstanceOf(BadRequestException)
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(projection).not.toHaveBeenCalled()
    const failed = setup()
    failed.db.imageGenJob.create.mockRejectedValue(new Error("database failed"))
    await expect(failed.service.saveCrop(7, 101, url, key)).rejects.toThrow("database failed")
    expect(failed.storage.deleteObject).not.toHaveBeenCalled()
  })

  it("删除副本后旧键不重建；裁剪归档不进入生成工作流", async () => {
    const { service, storage, db, archived } = setup()
    db.chetaidouTask.findFirst.mockReset().mockResolvedValue(archived)
    db.imageGenItem.findFirst.mockResolvedValue({ ...source, deletedAt: new Date() } as never)
    await expect(service.saveCrop(7, 101, url, key)).rejects.toBeInstanceOf(ConflictException)
    expect(storage.inspectCropPng).not.toHaveBeenCalled()
    jest.spyOn(service, "requireOwnedTask").mockResolvedValue(archived as never)
    await expect(service.retryTask(7, "archive", { idempotencyKey: key })).rejects.toThrow(
      "保存接口重试"
    )
    await expect(service.cancelTask(7, "archive")).rejects.toThrow("无需取消")
    await expect(service.applyTask(7, "archive", 0)).rejects.toThrow("无需应用")
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})
