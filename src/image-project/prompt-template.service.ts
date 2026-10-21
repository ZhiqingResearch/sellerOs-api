import { ConflictException, Injectable, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import {
  CreatePromptTemplateDto,
  GroupedPromptTemplateQueryDto,
  ListPromptTemplateQueryDto,
  UpdatePromptTemplateDto,
} from "./prompt-template.dto"

@Injectable()
export class PromptTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePromptTemplateDto) {
    try {
      return await this.prisma.imagePromptTemplate.create({
        data: {
          dimension: dto.dimension.trim(),
          name: dto.name.trim(),
          prompt: dto.prompt,
          enabled: dto.enabled ?? true,
          sortOrder: dto.sortOrder ?? 0,
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException("该维度下已存在同名功能")
      }
      throw err
    }
  }

  async findAll(query: ListPromptTemplateQueryDto) {
    const { page = 1, pageSize = 10, dimension, enabled, keyword } = query
    const where: Prisma.ImagePromptTemplateWhereInput = {
      ...(dimension ? { dimension } : {}),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(keyword
        ? {
            OR: [{ name: { contains: keyword } }, { prompt: { contains: keyword } }],
          }
        : {}),
    }

    const [total, items] = await Promise.all([
      this.prisma.imagePromptTemplate.count({ where }),
      this.prisma.imagePromptTemplate.findMany({
        where,
        orderBy: [{ dimension: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return { total, page, pageSize, items }
  }

  /** 按维度分组返回，admin 页 Tab + 前端 Composer 共用 */
  async findGrouped(query: GroupedPromptTemplateQueryDto) {
    const where: Prisma.ImagePromptTemplateWhereInput = query.enabledOnly ? { enabled: true } : {}

    const items = await this.prisma.imagePromptTemplate.findMany({
      where,
      orderBy: [{ dimension: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    })

    // 维持插入顺序的分组：第一次出现的维度排在前
    const map = new Map<string, typeof items>()
    for (const it of items) {
      const list = map.get(it.dimension)
      if (list) list.push(it)
      else map.set(it.dimension, [it])
    }

    const dimensions = Array.from(map.entries()).map(([dimension, list]) => ({
      dimension,
      count: list.length,
      items: list,
    }))

    return { total: items.length, dimensions }
  }

  /** 维度聚合（distinct + count），新增弹窗下拉框使用 */
  async findDimensions() {
    const groups = await this.prisma.imagePromptTemplate.groupBy({
      by: ["dimension"],
      _count: { _all: true },
      orderBy: { dimension: "asc" },
    })
    return groups.map(g => ({ dimension: g.dimension, count: g._count._all }))
  }

  async update(id: number, dto: UpdatePromptTemplateDto) {
    await this.ensureExists(id)
    try {
      return await this.prisma.imagePromptTemplate.update({
        where: { id },
        data: {
          dimension: dto.dimension?.trim(),
          name: dto.name?.trim(),
          prompt: dto.prompt,
          enabled: dto.enabled,
          sortOrder: dto.sortOrder,
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException("该维度下已存在同名功能")
      }
      throw err
    }
  }

  async remove(id: number) {
    await this.ensureExists(id)
    await this.prisma.imagePromptTemplate.delete({ where: { id } })
    return { id }
  }

  private async ensureExists(id: number) {
    const exists = await this.prisma.imagePromptTemplate.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!exists) throw new NotFoundException("提示词模板不存在")
  }
}
