import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import { CreateOrgDto } from "./dto/create-org.dto"
import { OrgItemDto } from "./dto/org-response.dto"
import { UpdateOrgDto } from "./dto/update-org.dto"

@Injectable()
export class OrgsService {
  private readonly logger = new Logger(OrgsService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** 组织列表，含用户数 */
  async list(): Promise<OrgItemDto[]> {
    const rows = await this.prisma.organization.findMany({
      orderBy: { id: "asc" },
      include: { _count: { select: { users: true } } },
    })
    return rows.map(r => this.toOrgItem(r))
  }

  /** 新建组织（名称查重） */
  async createOrg(dto: CreateOrgDto): Promise<OrgItemDto> {
    await this.assertNameAvailable(dto.name)
    const org = await this.prisma.organization.create({
      data: { name: dto.name, note: dto.note ?? null },
      include: { _count: { select: { users: true } } },
    })
    this.logger.log(`Organization created: ${dto.name} (#${org.id})`)
    return this.toOrgItem(org)
  }

  /** 重命名 / 改备注（名称查重） */
  async updateOrg(id: number, dto: UpdateOrgDto): Promise<OrgItemDto> {
    const org = await this.prisma.organization.findUnique({ where: { id }, select: { name: true } })
    if (!org) throw new NotFoundException("组织不存在")
    if (dto.name !== undefined && dto.name !== org.name) {
      await this.assertNameAvailable(dto.name)
    }

    const updated = await this.prisma.organization.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
      include: { _count: { select: { users: true } } },
    })
    return this.toOrgItem(updated)
  }

  /** 删除组织：其下有用户不可删 */
  async deleteOrg(id: number): Promise<{ id: number }> {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    })
    if (!org) throw new NotFoundException("组织不存在")
    if (org._count.users > 0) {
      throw new ConflictException(`该组织下还有 ${org._count.users} 名用户，无法删除`)
    }
    await this.prisma.organization.delete({ where: { id } })
    this.logger.log(`Organization deleted: ${org.name} (#${id})`)
    return { id }
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private toOrgItem(org: {
    id: number
    name: string
    note: string | null
    createdAt: Date
    _count: { users: number }
  }): OrgItemDto {
    return {
      id: org.id,
      name: org.name,
      note: org.note,
      usersCount: org._count.users,
      createdAt: org.createdAt.toISOString(),
    }
  }

  private async assertNameAvailable(name: string): Promise<void> {
    const exists = await this.prisma.organization.findUnique({
      where: { name },
      select: { id: true },
    })
    if (exists) throw new ConflictException(`组织「${name}」已存在`)
  }
}
