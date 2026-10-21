/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { PoolImageService } from "./pool-image.service"

const buildPrisma = () =>
  ({
    poolImage: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ group: null }),
    },
    imageProject: {
      findFirst: jest.fn().mockResolvedValue({ id: 5 }),
    },
    // persistVariants 传的是 create 数组，直接 Promise.all
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  }) as never

describe("PoolImageService kind", () => {
  it("列表不传 kind 时不过滤，传 kind 时按类型过滤", async () => {
    const prisma = buildPrisma()
    const service = new PoolImageService(prisma, {} as never)

    await service.findAll({ page: 1, pageSize: 10 } as never, 7)
    await service.findAll({ page: 1, pageSize: 10, kind: "competitor" } as never, 7)

    const calls = (prisma as { poolImage: { findMany: jest.Mock } }).poolImage.findMany.mock.calls
    expect(calls[0][0].where).not.toHaveProperty("kind")
    expect(calls[1][0].where).toEqual(expect.objectContaining({ userId: 7, kind: "competitor" }))
  })

  it("手动存入不传 kind 落普通素材图，传 competitor 落竞品参考图", async () => {
    const prisma = buildPrisma()
    const service = new PoolImageService(prisma, {} as never)

    await service.store({ name: "普通图", url: "https://example.com/a.png" } as never, 7)
    await service.store(
      { name: "竞品图", url: "https://example.com/b.png", kind: "competitor" } as never,
      7
    )

    const calls = (prisma as { poolImage: { create: jest.Mock } }).poolImage.create.mock.calls
    expect(calls[0][0].data.kind).toBe("image")
    expect(calls[1][0].data.kind).toBe("competitor")
  })

  it("手动存入传 projectId 校验本人电商项目归属并落库，不传落公共库", async () => {
    const prisma = buildPrisma()
    const service = new PoolImageService(prisma, {} as never)

    await service.store(
      {
        name: "竞品图",
        url: "https://example.com/c.png",
        kind: "competitor",
        projectId: 5,
      } as never,
      7
    )
    await service.store({ name: "普通图", url: "https://example.com/d.png" } as never, 7)

    const projectFindFirst = (prisma as { imageProject: { findFirst: jest.Mock } }).imageProject
      .findFirst
    expect(projectFindFirst).toHaveBeenCalledTimes(1)
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: 7, type: "ECOMMERCE", source: "platform" },
      select: { id: true },
    })

    const calls = (prisma as { poolImage: { create: jest.Mock } }).poolImage.create.mock.calls
    expect(calls[0][0].data.projectId).toBe(5)
    expect(calls[1][0].data.projectId).toBeNull()
  })

  it("手动存入 projectId 非本人电商项目返回 404 不落库", async () => {
    const prisma = buildPrisma()
    ;(
      prisma as { imageProject: { findFirst: jest.Mock } }
    ).imageProject.findFirst.mockResolvedValue(null)
    const service = new PoolImageService(prisma, {} as never)

    await expect(
      service.store(
        { name: "竞品图", url: "https://example.com/e.png", projectId: 999 } as never,
        7
      )
    ).rejects.toThrow("电商创作项目不存在")
    expect((prisma as { poolImage: { create: jest.Mock } }).poolImage.create).not.toHaveBeenCalled()
  })

  it("同名不同 URL 的图都能入池（name 不参与去重）", async () => {
    const prisma = buildPrisma()
    const service = new PoolImageService(prisma, {} as never)

    await service.store(
      { name: "tupian", url: "https://example.com/a.png", prompt: "同一提示词" } as never,
      7
    )
    await service.store(
      { name: "tupian", url: "https://example.com/b.png", prompt: "同一提示词" } as never,
      7
    )

    const findFirst = (prisma as { poolImage: { findFirst: jest.Mock } }).poolImage.findFirst
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 7, url: "https://example.com/b.png" } })
    )
    expect((prisma as { poolImage: { create: jest.Mock } }).poolImage.create).toHaveBeenCalledTimes(
      2
    )
  })

  it("同一 URL 重复入池返回 409 已在素材池中", async () => {
    const prisma = buildPrisma()
    ;(prisma as { poolImage: { findFirst: jest.Mock } }).poolImage.findFirst.mockResolvedValue({
      id: 1,
    })
    const service = new PoolImageService(prisma, {} as never)

    await expect(
      service.store({ name: "tupian", url: "https://example.com/a.png" } as never, 7)
    ).rejects.toThrow("已在素材池中")
    expect((prisma as { poolImage: { create: jest.Mock } }).poolImage.create).not.toHaveBeenCalled()
  })

  it("无 URL 的占位素材跳过判重直接入池", async () => {
    const prisma = buildPrisma()
    const service = new PoolImageService(prisma, {} as never)

    await service.store({ name: "占位", hue: 120 } as never, 7)

    expect(
      (prisma as { poolImage: { findFirst: jest.Mock } }).poolImage.findFirst
    ).not.toHaveBeenCalled()
    expect((prisma as { poolImage: { create: jest.Mock } }).poolImage.create).toHaveBeenCalledTimes(
      1
    )
  })

  it("无源图的变体落普通素材图", async () => {
    const prisma = buildPrisma()
    const service = new PoolImageService(prisma, {} as never)

    await service.persistVariants(
      {
        sourceLabel: "生成2·变体",
        items: [{ url: "https://example.com/v2.png", name: "生成2·变体1" }],
      } as never,
      7
    )

    const create = (prisma as { poolImage: { create: jest.Mock } }).poolImage.create
    expect(create.mock.calls[0][0].data.kind).toBe("image")
  })

  it("源图为竞品参考图时，变体继承 competitor 与项目归属", async () => {
    const prisma = buildPrisma()
    ;(prisma as { poolImage: { findUnique: jest.Mock } }).poolImage.findUnique.mockResolvedValue({
      userId: 7,
      order: 3,
      kind: "competitor",
      projectId: 5,
    })
    const service = new PoolImageService(prisma, {} as never)

    await service.persistVariants(
      {
        sourceLabel: "竞品·变体",
        sourceImageId: 501,
        items: [{ url: "https://example.com/v1.png", name: "竞品·变体1" }],
      } as never,
      7
    )

    const findUnique = (prisma as { poolImage: { findUnique: jest.Mock } }).poolImage.findUnique
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 501 },
        select: { userId: true, order: true, kind: true, projectId: true },
      })
    )
    const create = (prisma as { poolImage: { create: jest.Mock } }).poolImage.create
    expect(create.mock.calls[0][0].data.kind).toBe("competitor")
    expect(create.mock.calls[0][0].data.projectId).toBe(5)
  })
})
