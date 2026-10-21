import { Injectable } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"

const TTL_MS = 5 * 60 * 1000

/**
 * 后台充值账号白名单（User.canRecharge）的读取 + 5 分钟 TTL 缓存。
 * 充值是账号级门（连超管也需显式开），故不走权限点；toggle 时 invalidate。
 */
@Injectable()
export class RechargeAccessService {
  private readonly cache = new Map<number, { value: boolean; expireAt: number }>()

  constructor(private readonly prisma: PrismaService) {}

  async canRecharge(userId: number): Promise<boolean> {
    const cached = this.cache.get(userId)
    if (cached && cached.expireAt > Date.now()) return cached.value

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { canRecharge: true },
    })
    const value = user?.canRecharge ?? false
    this.cache.set(userId, { value, expireAt: Date.now() + TTL_MS })
    return value
  }

  invalidate(userId: number) {
    this.cache.delete(userId)
  }
}
