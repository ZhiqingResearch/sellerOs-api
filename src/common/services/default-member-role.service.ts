import { Injectable, InternalServerErrorException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Prisma } from "@prisma/client"

/** 邀请审批、企业添加成员共用的默认平台角色；角色绑定随业务事务提交。 */
@Injectable()
export class DefaultMemberRoleService {
  constructor(private readonly config: ConfigService) {}

  async assign(tx: Prisma.TransactionClient, userId: number): Promise<void> {
    const value = this.config.get<string>("DEFAULT_MEMBER_ROLE_ID")?.trim()
    if (!value) {
      throw new InternalServerErrorException("系统未配置默认成员角色（DEFAULT_MEMBER_ROLE_ID）")
    }
    const roleId = Number(value)
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(roleId) ||
      roleId <= 0 ||
      roleId > 2147483647
    ) {
      throw new InternalServerErrorException("默认成员角色 ID 必须为有效的正整数")
    }
    const role = await tx.roleModel.findUnique({ where: { id: roleId }, select: { id: true } })
    if (!role) {
      throw new InternalServerErrorException("配置的默认成员角色不存在，请联系管理员")
    }
    // 只追加默认角色：不复制邀请人角色，也不删除已有账号的角色。
    await tx.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { userId, roleId },
      update: {},
    })
  }
}
