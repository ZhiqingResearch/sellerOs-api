import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma, SensitiveWordSource } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { CreateSensitiveWordDto } from "./dto/create-sensitive-word.dto"
import { QuerySensitiveWordDto } from "./dto/query-sensitive-word.dto"
import { StatsQueryDto } from "./dto/stats-query.dto"
import { UpdateSensitiveWordDto } from "./dto/update-sensitive-word.dto"

/** 前端可识别的错误 code，配合 ConflictException(body.code) 一起返回 */
const ERR_DUPLICATE = "SENSITIVE_WORD_EXISTS"
const DUPLICATE_MESSAGE = "该平台下已存在相同敏感词"

@Injectable()
export class SensitiveWordService {
  private readonly logger = new Logger(SensitiveWordService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Controller 入口：source 优先取 DTO，未传则缺省为 MANUAL */
  create(userId: number, dto: CreateSensitiveWordDto) {
    return this.doCreate(userId, dto, dto.source ?? SensitiveWordSource.MANUAL)
  }

  /**
   * 内部模块来源（Listing 生成 / AI 判定 / 初始数据导入）入库入口，不经 Controller。
   * userId 允许 null，但此时 source 必须是 AI_DETECTION；
   * 与手动创建语义一致：支持 word 数组批量，冲突的跳过进 conflicts。
   */
  createFromSystem(
    userId: number | null,
    dto: CreateSensitiveWordDto,
    source: SensitiveWordSource
  ) {
    return this.doCreate(userId, dto, source)
  }

  /**
   * 创建敏感词：
   * - dto.word 是前端拆好的数组；后端 trim + 过空串 + 去重 后逐条入库
   * - userId 为 null 时强制要求 source=AI_DETECTION
   * - (platform, word) 唯一约束撞了 → 跳过该条，进 conflicts
   * - 一条都没成功（全部冲突）→ 抛 409；否则返回 201 + { created, conflicts }
   */
  private async doCreate(
    userId: number | null,
    dto: CreateSensitiveWordDto,
    source: SensitiveWordSource
  ) {
    if (userId == null && source !== SensitiveWordSource.AI_DETECTION) {
      throw new BadRequestException("userId 为空时来源必须是 AI_DETECTION")
    }

    const words = this.normalizeWords(dto.word)
    if (words.length === 0) {
      throw new BadRequestException("敏感词不能为空")
    }

    const created: unknown[] = []
    const conflicts: string[] = []

    for (const word of words) {
      try {
        const row = await this.prisma.sensitiveWord.create({
          data: {
            word,
            platform: dto.platform,
            category: dto.category,
            riskLevel: dto.riskLevel,
            source,
            suggestion: dto.suggestion ?? null,
            userId,
          },
          include: { user: { select: { id: true, username: true } } },
        })
        this.logger.log(
          `SensitiveWord created: id=${row.id}, platform=${row.platform}, word=${row.word}`
        )
        created.push(row)
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          conflicts.push(word)
          continue
        }
        throw e
      }
    }

    if (created.length === 0) {
      throw new ConflictException({
        code: ERR_DUPLICATE,
        message: DUPLICATE_MESSAGE,
        conflicts,
      })
    }

    return { created, conflicts }
  }

  /** [" A ", "B", "", "A", "C"] → ["A", "B", "C"]：trim + 过空 + 去重，保持原顺序 */
  private normalizeWords(input: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const raw of input) {
      const w = (raw ?? "").trim()
      if (!w) continue
      if (seen.has(w)) continue
      seen.add(w)
      result.push(w)
    }
    return result
  }

  async findAll(query: QuerySensitiveWordDto) {
    const { page, pageSize, platform, category, word, source, userId } = query
    const where: Prisma.SensitiveWordWhereInput = {
      ...(platform && { platform }),
      // category 现在是 JSON 数组，用 array_contains 命中"包含该分类"的行
      ...(category && { category: { array_contains: category } }),
      ...(word && { word: { contains: word } }),
      ...(source && { source }),
      ...(userId && { userId }),
    }

    const [items, total] = await Promise.all([
      this.prisma.sensitiveWord.findMany({
        where,
        include: { user: { select: { id: true, username: true } } },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.sensitiveWord.count({ where }),
    ])

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /**
   * 统计：一次性返回全部平台 + 每平台的分类分布。
   *
   * - 前端切平台 tab 不再回源，直接读 platforms[i].categories
   * - source / userId 是横切过滤；platform 不过滤（它是返回结构的 tab 维度）
   * - 因为 category 是 JSON 数组（一条记录可挂多个分类），所以 **一行可能贡献到多个分类计数**：
   *     row.platform="amazon", row.category=["保健品","美容"]
   *       → 对 amazon.count +1，对 amazon.categories.保健品 +1，对 amazon.categories.美容 +1
   *     所以 sum(categories[].count) ≥ platform.count，前端不要假设它们相等
   * - JSON 数组 groupBy 不支持，统一走 findMany + JS 聚合；
   *   敏感词后台量级（< 1 万行）下内存压力可控，超过再换 raw SQL（MySQL JSON_TABLE）
   * - 排序：平台按 count 降序；分类在所属平台内按 count 降序
   */
  async stats(query: StatsQueryDto = {}) {
    const { source, userId } = query
    const where: Prisma.SensitiveWordWhereInput = {
      ...(source && { source }),
      ...(userId && { userId }),
    }

    const [total, rows] = await Promise.all([
      this.prisma.sensitiveWord.count({ where }),
      this.prisma.sensitiveWord.findMany({
        where,
        select: { platform: true, category: true },
      }),
    ])

    const platformMap = new Map<string, { count: number; catMap: Map<string, number> }>()
    for (const row of rows) {
      const cats = Array.isArray(row.category) ? row.category : []
      const entry = platformMap.get(row.platform) ?? {
        count: 0,
        catMap: new Map<string, number>(),
      }
      entry.count += 1
      for (const c of cats) {
        if (typeof c === "string" && c.length > 0) {
          entry.catMap.set(c, (entry.catMap.get(c) ?? 0) + 1)
        }
      }
      platformMap.set(row.platform, entry)
    }

    const platforms = Array.from(platformMap.entries())
      .map(([key, v]) => ({
        key,
        count: v.count,
        categories: Array.from(v.catMap.entries())
          .map(([k, c]) => ({ key: k, count: c }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count)

    return { total, platforms }
  }

  /**
   * 返回所有"创建过至少一条敏感词"的用户精简列表，供前端筛选下拉框使用。
   * 不分页（量级 = 后台运营人数，可控）。按 username 升序。
   */
  async findUsersWithSensitiveWords() {
    return this.prisma.user.findMany({
      where: { sensitiveWords: { some: {} } },
      select: { id: true, username: true },
      orderBy: { username: "asc" },
    })
  }

  async findById(id: number) {
    const record = await this.prisma.sensitiveWord.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true } } },
    })
    if (!record) throw new NotFoundException("敏感词不存在")
    return record
  }

  /**
   * 更新：
   * - word 是单值 string（DTO 层就限定了单值，与创建的数组类型分离）
   * - category 整体替换（前端要增/减分类需自行 merge 后传完整数组）
   * - (platform, word) 撞 DB 已存在 → 翻成 409
   */
  async update(id: number, dto: UpdateSensitiveWordDto) {
    const existing = await this.prisma.sensitiveWord.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException("敏感词不存在")

    try {
      const updated = await this.prisma.sensitiveWord.update({
        where: { id },
        data: {
          ...(dto.word !== undefined && { word: dto.word }),
          ...(dto.platform !== undefined && { platform: dto.platform }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.riskLevel !== undefined && { riskLevel: dto.riskLevel }),
          ...(dto.suggestion !== undefined && { suggestion: dto.suggestion }),
        },
        include: { user: { select: { id: true, username: true } } },
      })
      this.logger.log(`SensitiveWord updated: id=${updated.id}`)
      return updated
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException({ code: ERR_DUPLICATE, message: DUPLICATE_MESSAGE })
      }
      throw e
    }
  }

  /**
   * 批量物理删除：
   * - 不存在的 id 不报错，进 missing 列表，让前端可提示「这几条已经不在了」
   * - 返回 { deleted, requested, missing }：requested 是去重后的 id 数，deleted 是实际删掉的行数
   */
  async removeMany(ids: number[]) {
    const existing = await this.prisma.sensitiveWord.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    })
    const existingIds = new Set(existing.map(r => r.id))
    const missing = ids.filter(id => !existingIds.has(id))

    let deleted = 0
    if (existingIds.size > 0) {
      const result = await this.prisma.sensitiveWord.deleteMany({
        where: { id: { in: Array.from(existingIds) } },
      })
      deleted = result.count
    }

    this.logger.log(
      `SensitiveWord bulk deleted: requested=${ids.length} deleted=${deleted} missing=${missing.length}`
    )
    return { deleted, requested: ids.length, missing }
  }
}
