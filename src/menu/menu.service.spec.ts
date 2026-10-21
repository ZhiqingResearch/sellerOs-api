import { BadRequestException } from "@nestjs/common"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { PrismaService } from "../prisma/prisma.service"
import { MenuGroupService } from "./menu-group.service"
import { MenuService } from "./menu.service"
import { CreateMenuDto } from "./dto/create-menu.dto"

function createService() {
  const tx = {
    permission: { create: jest.fn() },
    rolePermission: { create: jest.fn() },
  }
  const prisma = {
    permissionGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    permission: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    roleModel: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
  }
  const permissionCache = { invalidateAll: jest.fn() }
  const menuGroups = new MenuGroupService(prisma as never)
  const service = new MenuService(
    prisma as unknown as PrismaService,
    permissionCache as never,
    menuGroups
  )
  return { service, menuGroups, permissionCache, prisma, tx }
}

function menuRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    key: "tool.a",
    label: "A",
    groupCode: "tools",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 1,
    ...overrides,
  }
}

describe("MenuService 分组联动", () => {
  it("createMenu 顶级菜单：分组必须已存在", async () => {
    const { service, prisma, tx } = createService()
    const dto: CreateMenuDto = {
      key: "tool.custom_report",
      label: "自定义报表",
      groupCode: "ghost",
    }
    await expect(service.createMenu(dto)).rejects.toBeInstanceOf(BadRequestException)

    prisma.permissionGroup.findUnique.mockResolvedValue({ id: 1 })
    tx.permission.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve(menuRow(args.data))
    )
    await expect(
      service.createMenu({ key: "tool.custom_report", label: "自定义报表", groupCode: "tools" })
    ).resolves.toMatchObject({ groupCode: "tools" })
  })

  it("updateMenu 顶级菜单换组：新分组必须已存在", async () => {
    const { service, prisma } = createService()
    prisma.permission.findUnique.mockResolvedValue(menuRow({}))
    prisma.permissionGroup.findUnique.mockResolvedValue(null)

    await expect(service.updateMenu(1, { groupCode: "ghost" })).rejects.toBeInstanceOf(
      BadRequestException
    )
  })

  it("getTree：按分组表 sortOrder 输出分组，menuCount 统计组内全部节点，孤儿分组兜底在最后", async () => {
    const { service, prisma } = createService()
    prisma.permissionGroup.findMany.mockResolvedValue([
      { id: 2, code: "agents", label: "智能体", isBuiltin: true, sortOrder: 1 },
      { id: 1, code: "tools", label: "工具", isBuiltin: true, sortOrder: 2 },
    ])
    prisma.permission.findMany.mockResolvedValue([
      menuRow({ id: 1, key: "tool.a", sortOrder: 1 }),
      menuRow({ id: 2, key: "tool.b", sortOrder: 2 }),
      menuRow({ id: 3, key: "agent.x", groupCode: "agents", sortOrder: 3 }),
      menuRow({ id: 4, key: "legacy.x", groupCode: "legacy", sortOrder: 4 }),
    ])

    const result = await service.getTree()

    expect(result.groups.map(g => g.code)).toEqual(["agents", "tools", "legacy"])
    expect(result.groups).toMatchObject([
      { code: "agents", label: "智能体", menuCount: 1 },
      { code: "tools", label: "工具", menuCount: 2 },
      { code: "legacy", label: "legacy", menuCount: 1 },
    ])
    // 组内菜单保持 sortOrder 顺序
    expect(result.groups[1].menus.map(m => m.key)).toEqual(["tool.a", "tool.b"])
  })
})
