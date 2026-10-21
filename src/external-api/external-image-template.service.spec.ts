import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { ExternalImageTemplateService } from "./external-image-template.service"

describe("ExternalImageTemplateService", () => {
  const phone = "13800001234"
  const result = { total: 1, page: 1, pageSize: 20, items: [{ id: 10 }] }
  let prisma: { user: { findUnique: jest.Mock } }
  let imageTemplateService: {
    findAll: jest.Mock
    tabCounts: jest.Mock
    findGroups: jest.Mock
    listGroups: jest.Mock
    createGroup: jest.Mock
    renameGroup: jest.Mock
    deleteGroup: jest.Mock
    findTags: jest.Mock
    findOne: jest.Mock
    create: jest.Mock
    importTemplates: jest.Mock
    addItem: jest.Mock
    copy: jest.Mock
    update: jest.Mock
    remove: jest.Mock
  }
  let service: ExternalImageTemplateService

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } }
    imageTemplateService = {
      findAll: jest.fn().mockResolvedValue(result),
      tabCounts: jest.fn(),
      findGroups: jest.fn(),
      listGroups: jest.fn(),
      createGroup: jest.fn(),
      renameGroup: jest.fn(),
      deleteGroup: jest.fn(),
      findTags: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      importTemplates: jest.fn(),
      addItem: jest.fn(),
      copy: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    }
    service = new ExternalImageTemplateService(prisma as never, imageTemplateService as never)
  })

  it("使用请求头传入的手机号解析有效用户并复用模板筛选逻辑", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, isActive: true })
    const query = {
      page: 1,
      pageSize: 20,
      tab: "all" as const,
      groupId: 2,
      tag: "Amazon",
      keyword: "A+",
    }

    await expect(service.findByPhone(phone, query)).resolves.toEqual(result)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { phone },
      select: { id: true, isActive: true },
    })
    expect(imageTemplateService.findAll).toHaveBeenCalledWith(query, 7)
  })

  it("为所有查询与聚合操作解析请求头手机号并复用用户侧服务", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, isActive: true })

    await service.tabCounts(phone)
    await service.findGroups(phone, { tab: "mine" })
    await service.listGroups(phone)
    await service.findTags(phone, { tab: "system" })
    await service.findOne(phone, 10)

    expect(imageTemplateService.tabCounts).toHaveBeenCalledWith(7)
    expect(imageTemplateService.findGroups).toHaveBeenCalledWith(7, "mine")
    expect(imageTemplateService.listGroups).toHaveBeenCalledWith(7)
    expect(imageTemplateService.findTags).toHaveBeenCalledWith(7, "system")
    expect(imageTemplateService.findOne).toHaveBeenCalledWith(10, 7)
  })

  it("为所有个人模板写操作解析请求头手机号并复用归属校验逻辑", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, isActive: true })

    await service.create(phone, { name: "A+", items: [] })
    await service.update(phone, 10, { name: "A+ 新版" })
    await service.addItem(phone, 10, { name: "主图", prompt: "白底产品主图" })
    await service.copy(phone, 10, { name: "A+ 副本", groupName: "Amazon" })
    await service.importTemplates(phone, [10, 11])
    await service.remove(phone, 10)

    expect(imageTemplateService.create).toHaveBeenCalledWith({ name: "A+", items: [] }, 7)
    expect(imageTemplateService.update).toHaveBeenCalledWith(10, { name: "A+ 新版" }, 7)
    expect(imageTemplateService.addItem).toHaveBeenCalledWith(
      10,
      { name: "主图", prompt: "白底产品主图" },
      7
    )
    expect(imageTemplateService.copy).toHaveBeenCalledWith(
      10,
      { name: "A+ 副本", groupName: "Amazon" },
      7
    )
    expect(imageTemplateService.importTemplates).toHaveBeenCalledWith([10, 11], 7)
    expect(imageTemplateService.remove).toHaveBeenCalledWith(10, 7)
  })

  it("为所有个人分组写操作解析请求头手机号并复用分组归属校验逻辑", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, isActive: true })

    await service.createGroup(phone, "Amazon")
    await service.renameGroup(phone, 2, "Amazon A+")
    await service.deleteGroup(phone, 2)

    expect(imageTemplateService.createGroup).toHaveBeenCalledWith(7, "Amazon")
    expect(imageTemplateService.renameGroup).toHaveBeenCalledWith(7, 2, "Amazon A+")
    expect(imageTemplateService.deleteGroup).toHaveBeenCalledWith(7, 2)
  })

  it("请求头手机号对应账户不存在时返回无此账户信息", async () => {
    prisma.user.findUnique.mockResolvedValue(null)

    await expect(service.findByPhone(phone, {})).rejects.toEqual(
      expect.objectContaining<Partial<NotFoundException>>({ message: "无此账户信息" })
    )
    expect(imageTemplateService.findAll).not.toHaveBeenCalled()
  })

  it("请求头手机号对应账户停用时拒绝查询模板", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, isActive: false })

    await expect(service.findByPhone(phone, {})).rejects.toEqual(
      expect.objectContaining<Partial<ForbiddenException>>({ message: "账户已停用" })
    )
    expect(imageTemplateService.findAll).not.toHaveBeenCalled()
  })

  it("请求头手机号对应账户停用时拒绝写入模板", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, isActive: false })

    await expect(service.create(phone, { name: "A+", items: [] })).rejects.toEqual(
      expect.objectContaining<Partial<ForbiddenException>>({ message: "账户已停用" })
    )
    expect(imageTemplateService.create).not.toHaveBeenCalled()
  })
})
