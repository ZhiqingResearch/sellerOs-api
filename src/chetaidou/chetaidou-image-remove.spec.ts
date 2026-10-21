import { RequestMethod } from "@nestjs/common"
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { PrismaService } from "../prisma/prisma.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { ChetaidouImageOptionsService } from "./chetaidou-image-options.service"
import { ChetaidouStorageService } from "./chetaidou-storage.service"
import { ChetaidouController } from "./chetaidou.controller"
import { ChetaidouService } from "./chetaidou.service"

describe("移除本人上传母版", () => {
  function setup() {
    const image = { id: 8, ownerId: 7, sourceType: "USER_UPLOAD", enabled: true, revision: 2 }
    const db = {
      chetaidouImage: {
        findUnique: jest.fn().mockResolvedValue(image),
        updateMany: jest.fn(() => {
          const count = image.enabled ? 1 : 0
          image.enabled = false
          image.revision += count
          return Promise.resolve({ count })
        }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      chetaidouSku: { findUnique: jest.fn().mockResolvedValue({ id: 1, enabled: true }) },
      chetaidouTask: { deleteMany: jest.fn(), updateMany: jest.fn() },
      imageGenItem: { deleteMany: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    }
    const storage = { deleteObject: jest.fn() }
    const service = new ChetaidouService(
      db as unknown as PrismaService,
      {} as ChetaidouContextService,
      storage as unknown as ChetaidouStorageService,
      {} as ChetaidouBillingService,
      {} as ChetaidouImageOptionsService
    )
    return { image, db, storage, service }
  }

  it("路由为 DELETE /images/:id，成功返回 200", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 只读取装饰器元数据，不调用方法。
    const handler = ChetaidouController.prototype.removeImage
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("images/:id")
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.DELETE)
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200)
  })

  it("逻辑移除本人上传图，保留文件、在途任务和历史结果", async () => {
    const { service, db, storage } = setup()
    await expect(service.removeImage(7, 8)).resolves.toEqual({ imageId: 8, removed: true })
    expect(db.chetaidouImage.updateMany).toHaveBeenCalledWith({
      where: { id: 8, sourceType: "USER_UPLOAD", ownerId: 7, enabled: true },
      data: { enabled: false, revision: { increment: 1 } },
    })
    expect(storage.deleteObject).not.toHaveBeenCalled()
    expect(db.chetaidouTask.deleteMany).not.toHaveBeenCalled()
    expect(db.chetaidouTask.updateMany).not.toHaveBeenCalled()
    expect(db.imageGenItem.deleteMany).not.toHaveBeenCalled()
    expect(db.imageGenItem.updateMany).not.toHaveBeenCalled()
    expect(db.chetaidouSku.findUnique).not.toHaveBeenCalled()
  })

  it("重复及并发移除幂等，版本只增加一次", async () => {
    const { service, image } = setup()
    await expect(
      Promise.all([service.removeImage(7, 8), service.removeImage(7, 8)])
    ).resolves.toEqual([
      { imageId: 8, removed: true },
      { imageId: 8, removed: true },
    ])
    await expect(service.removeImage(7, 8)).resolves.toEqual({ imageId: 8, removed: true })
    expect(image.revision).toBe(3)
  })

  it.each([true, false])("其他用户的上传图统一返回 404（enabled=%s）", async enabled => {
    const { service, image, db } = setup()
    image.enabled = enabled
    await expect(service.removeImage(99, 8)).rejects.toMatchObject({
      status: 404,
      response: { code: "IMAGE_NOT_FOUND", message: "图片不存在或无权移除" },
    })
    expect(db.chetaidouImage.updateMany).not.toHaveBeenCalled()
  })

  it("不存在的图片返回 404", async () => {
    const { service, db } = setup()
    db.chetaidouImage.findUnique.mockResolvedValue(null)
    await expect(service.removeImage(7, 8)).rejects.toMatchObject({ status: 404 })
    expect(db.chetaidouImage.updateMany).not.toHaveBeenCalled()
  })

  it("系统预置母版不可移除，即使 createdBy 是当前用户", async () => {
    const { service, db } = setup()
    db.chetaidouImage.findUnique.mockResolvedValue({
      id: 8,
      sourceType: "PRESET",
      ownerId: null,
      createdBy: 7,
      enabled: true,
    })
    await expect(service.removeImage(7, 8)).rejects.toMatchObject({
      status: 400,
      response: { code: "IMAGE_REMOVE_NOT_ALLOWED" },
    })
    expect(db.chetaidouImage.updateMany).not.toHaveBeenCalled()
  })

  it("移除后详情不可访问，列表及总数查询排除停用图片", async () => {
    const { service, db } = setup()
    await service.removeImage(7, 8)
    await expect(service.getImage(7, 8)).rejects.toMatchObject({ status: 404 })
    await expect(service.getDraft(7, 8)).rejects.toMatchObject({ status: 404 })
    await service.listImages(7, 1, { page: 1, pageSize: 20 })
    const where = {
      skuId: 1,
      enabled: true,
      AND: [{ OR: [{ sourceType: "PRESET" }, { sourceType: "USER_UPLOAD", ownerId: 7 }] }],
    }
    expect(db.chetaidouImage.count).toHaveBeenCalledWith({ where })
    expect(db.chetaidouImage.findMany).toHaveBeenCalledWith({
      where,
      orderBy: { id: "desc" },
      skip: 0,
      take: 20,
    })
  })
})
