import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"

const TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  keys: Set<string>
  expireAt: number
}

interface LabelCacheEntry {
  labelByKey: Map<string, string>
  expireAt: number
}

@Injectable()
export class PermissionCacheService {
  private readonly logger = new Logger(PermissionCacheService.name)
  private readonly cache = new Map<number, CacheEntry>()
  private labelCache: LabelCacheEntry | null = null

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 权限 key → 中文菜单 label 的全量映射（权限是小而固定的集合，整表缓存）。
   * 供权限不足时把原始 key 翻译成用户可读的中文菜单名。
   */
  async getLabelMap(): Promise<Map<string, string>> {
    if (this.labelCache && this.labelCache.expireAt > Date.now()) {
      return this.labelCache.labelByKey
    }
    const rows = await this.prisma.permission.findMany({
      select: { key: true, label: true },
    })
    const labelByKey = new Map(rows.map(r => [r.key, r.label]))
    this.labelCache = { labelByKey, expireAt: Date.now() + TTL_MS }
    return labelByKey
  }

  async getForUser(userId: number): Promise<Set<string>> {
    // 用户可挂多个角色，最终权限是各角色权限的并集。
    // 用户的角色绑定每次实时查（不缓存），单个角色的权限集合按 roleId 缓存。
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    })
    if (roles.length === 0) return new Set()
    const sets = await Promise.all(roles.map(r => this.getForRole(r.roleId)))
    return new Set(sets.flatMap(s => [...s]))
  }

  async getForRole(roleId: number): Promise<Set<string>> {
    const cached = this.cache.get(roleId)
    if (cached && cached.expireAt > Date.now()) {
      return cached.keys
    }
    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    })
    const keys = new Set(rows.map(r => r.permission.key))
    this.cache.set(roleId, { keys, expireAt: Date.now() + TTL_MS })
    return keys
  }

  invalidate(roleId: number) {
    this.cache.delete(roleId)
    this.logger.debug(`Permission cache invalidated for role ${roleId}`)
  }

  invalidateAll() {
    this.cache.clear()
    this.labelCache = null
    this.logger.debug("Permission cache fully cleared")
  }
}
