import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { MenuGroupService } from "./menu-group.service"

const now = new Date("2026-09-11T08:00:00.000Z")

function groupRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    code: "reports",
    label: "报表",
    isBuiltin: false,
    sortOrder: 9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createService() {
  const prisma = {
    permissionGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    permission: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  }
  return { service: new MenuGroupService(prisma as never), prisma }
}

describe("MenuGroupService", () => {
  it("lists groups ordered by sortOrder with per-group menu counts", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findMany.mockResolvedValue([
      groupRow({ id: 2, code: "agents", label: "智能体", isBuiltin: true, sortOrder: 1 }),
      groupRow({ id: 1, code: "reports", label: "报表", sortOrder: 2 }),
    ])
    prisma.permission.groupBy.mockResolvedValue([
      { groupCode: "reports", _count: { _all: 3 } },
    ])

    const result = await service.list()

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ code: "agents", menuCount: 0 })
    expect(result[1]).toMatchObject({ code: "reports", menuCount: 3 })
  })

  it("creates a group with the next sortOrder and rejects duplicate codes", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findUnique.mockResolvedValue(null)
    prisma.permissionGroup.findFirst.mockResolvedValue({ sortOrder: 4 })
    prisma.permissionGroup.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve(groupRow({ ...args.data }))
    )

    const created = await service.create({ code: "reports", label: "报表" })

    expect(created).toMatchObject({ code: "reports", label: "报表", sortOrder: 5, menuCount: 0 })
    // isBuiltin 走 schema 默认值 false，不入 create data
    expect(prisma.permissionGroup.create.mock.calls[0][0].data).toMatchObject({
      code: "reports",
      label: "报表",
      sortOrder: 5,
    })

    prisma.permissionGroup.findUnique.mockResolvedValue({ id: 9 })
    await expect(service.create({ code: "reports", label: "重复" })).rejects.toBeInstanceOf(
      ConflictException
    )
  })

  it("updates only label/sortOrder and 404s on missing groups", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findUnique.mockResolvedValue(groupRow())
    prisma.permissionGroup.update.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve(groupRow({ ...args.data }))
    )

    const updated = await service.update(1, { label: "报表中心", sortOrder: 2 })

    expect(updated).toMatchObject({ label: "报表中心", sortOrder: 2 })
    expect(prisma.permissionGroup.update.mock.calls[0][0].data).not.toHaveProperty("code")

    prisma.permissionGroup.findUnique.mockResolvedValue(null)
    await expect(service.update(99, { label: "x" })).rejects.toBeInstanceOf(NotFoundException)
  })

  it("refuses to delete builtin groups or groups that still have menus", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findUnique.mockResolvedValue(groupRow({ isBuiltin: true }))

    await expect(service.remove(1)).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.permissionGroup.delete).not.toHaveBeenCalled()

    prisma.permissionGroup.findUnique.mockResolvedValue(groupRow())
    prisma.permission.count.mockResolvedValue(5)
    await expect(service.remove(1)).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.permissionGroup.delete).not.toHaveBeenCalled()
  })

  it("deletes an empty non-builtin group", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findUnique.mockResolvedValue(groupRow())
    prisma.permission.count.mockResolvedValue(0)
    prisma.permissionGroup.delete.mockResolvedValue(groupRow())

    await expect(service.remove(1)).resolves.toMatchObject({ id: 1 })
    expect(prisma.permissionGroup.delete).toHaveBeenCalledWith({ where: { id: 1 } })
  })

  it("assertGroupExists rejects unknown group codes", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findUnique.mockResolvedValue(null)
    await expect(service.assertGroupExists("ghost")).rejects.toBeInstanceOf(BadRequestException)
  })
})
