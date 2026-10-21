import { ConflictException, Injectable, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"

@Injectable()
export class PoolGroupService {
  constructor(private readonly prisma: PrismaService) {}

  /** 分组列表 + 每组当前素材数（仅本人；无默认分组） */
  async findAll(userId: number) {
    const [groups, counts] = await Promise.all([
      this.prisma.poolGroup.findMany({
        where: { userId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      }),
      this.prisma.poolImage.groupBy({
        by: ["groupId"],
        where: { userId, groupId: { not: null } },
        _count: { _all: true },
      }),
    ])
    const countMap = new Map(counts.map(c => [c.groupId as number, c._count._all]))
    return groups.map(g => ({ id: g.id, name: g.name, count: countMap.get(g.id) ?? 0 }))
  }

  /** 新建分组（同名 409） */
  async create(userId: number, name: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new ConflictException("分组名不能为空")
    if (await this.exists(userId, trimmed)) throw new ConflictException("分组名已存在")
    const g = await this.prisma.poolGroup.create({ data: { userId, name: trimmed } })
    return { id: g.id, name: g.name, count: 0 }
  }

  /** 重命名分组（同名 409） */
  async rename(userId: number, id: number, name: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new ConflictException("分组名不能为空")
    const g = await this.assertOwned(id, userId)
    if (trimmed === g.name) return { id: g.id, name: g.name }
    if (await this.exists(userId, trimmed)) throw new ConflictException("分组名已存在")
    const updated = await this.prisma.poolGroup.update({ where: { id }, data: { name: trimmed } })
    return { id: updated.id, name: updated.name }
  }

  /** 删除分组：连带软删除组内素材图（二次确认在前端） */
  async remove(userId: number, id: number) {
    await this.assertOwned(id, userId)
    const now = new Date()
    const [res] = await this.prisma.$transaction([
      this.prisma.poolImage.updateMany({
        where: { groupId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.poolGroup.update({ where: { id }, data: { deletedAt: now } }),
    ])
    return { success: true, deletedImageCount: res.count }
  }

  /** 校验分组归属（pool-image 移动/存入时复用） */
  async assertOwned(id: number, userId: number) {
    const g = await this.prisma.poolGroup.findUnique({ where: { id } })
    if (!g || g.userId !== userId) throw new NotFoundException("分组不存在")
    return g
  }

  /** 同名查重：经软删扩展客户端自动过滤已删行，删除后的分组名可复用 */
  private async exists(userId: number, name: string) {
    return !!(await this.prisma.poolGroup.findFirst({
      where: { userId, name },
      select: { id: true },
    }))
  }
}
