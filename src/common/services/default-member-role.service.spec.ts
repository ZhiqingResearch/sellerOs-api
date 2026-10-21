import { InternalServerErrorException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Prisma } from "@prisma/client"
import { DefaultMemberRoleService } from "./default-member-role.service"

describe("DefaultMemberRoleService", () => {
  const setup = (value: string | undefined) => {
    const config = { get: jest.fn().mockReturnValue(value) }
    const tx = {
      roleModel: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) },
      userRole: { upsert: jest.fn().mockResolvedValue({}) },
    }
    const service = new DefaultMemberRoleService(config as unknown as ConfigService)
    return { service, tx, client: tx as unknown as Prisma.TransactionClient }
  }

  it.each([undefined, "", "   "])("配置缺失（%s）时拒绝绑定", async value => {
    const { service, tx, client } = setup(value)
    await expect(service.assign(client, 50)).rejects.toThrow("系统未配置默认成员角色")
    expect(tx.roleModel.findUnique).not.toHaveBeenCalled()
    expect(tx.userRole.upsert).not.toHaveBeenCalled()
  })

  it.each(["0", "-1", "1.5", "1e1", "11abc", "2147483648", "9".repeat(400)])(
    "配置非法（%s）时拒绝绑定",
    async value => {
      const { service, tx, client } = setup(value)
      await expect(service.assign(client, 50)).rejects.toBeInstanceOf(InternalServerErrorException)
      expect(tx.roleModel.findUnique).not.toHaveBeenCalled()
      expect(tx.userRole.upsert).not.toHaveBeenCalled()
    }
  )

  it("角色不存在时不写关联", async () => {
    const { service, tx, client } = setup("11")
    tx.roleModel.findUnique.mockResolvedValue(null)
    await expect(service.assign(client, 50)).rejects.toThrow("配置的默认成员角色不存在")
    expect(tx.userRole.upsert).not.toHaveBeenCalled()
  })

  it("角色绑定失败时将错误抛回外层业务事务", async () => {
    const { service, tx, client } = setup("11")
    const error = new Error("关联写入失败")
    tx.userRole.upsert.mockRejectedValue(error)
    await expect(service.assign(client, 50)).rejects.toBe(error)
  })

  it("重复绑定默认角色不新增重复关联，也不覆盖已有角色", async () => {
    const { service, tx, client } = setup(" 11 ")
    const roles = new Set(["50:3"])
    tx.userRole.upsert.mockImplementation(
      ({ create }: { create: { userId: number; roleId: number } }) => {
        roles.add(`${create.userId}:${create.roleId}`)
        return Promise.resolve({})
      }
    )
    await service.assign(client, 50)
    await service.assign(client, 50)
    expect(roles).toEqual(new Set(["50:3", "50:11"]))
    expect(tx.roleModel.findUnique).toHaveBeenCalledWith({
      where: { id: 11 },
      select: { id: true },
    })
  })
})
