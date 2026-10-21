import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { hashJson, isJsonObject } from "../product-selection/canonical-json"
import { BatchCreateProductLibraryItemsDto } from "./dto/batch-create-product-library-items.dto"
import { CreateProductLibraryItemDto } from "./dto/create-product-library-item.dto"
import {
  ProductLibrarySortBy,
  QueryProductLibraryItemDto,
} from "./dto/query-product-library-item.dto"
import { UpdateProductLibraryItemDto } from "./dto/update-product-library-item.dto"

const PRODUCT_PROFILE_MAX_BYTES = 2 * 1024 * 1024

interface NormalizedProductInput {
  asin?: string
  marketplace: string
  keyword: string
  title?: string
  brand?: string
  imageUrl?: string
  compScore?: number
  price?: number
  monthlySales?: number
  ratingNum?: number
  sourceAnalysisId: string
  tags?: string[]
  notes?: string
  profile: Prisma.InputJsonValue
  profileHash: string
}

@Injectable()
export class ProductLibraryService {
  private readonly logger = new Logger(ProductLibraryService.name)

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateProductLibraryItemDto) {
    const result = await this.saveItems(userId, [dto])
    return result.items[0]
  }

  async createBatch(userId: number, dto: BatchCreateProductLibraryItemsDto) {
    return this.saveItems(userId, dto.items)
  }

  async findAll(userId: number, query: QueryProductLibraryItemDto) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim()
    const category = query.category?.trim()
    assertValidRanges(query)
    const sourceWhere: Prisma.ProductLibrarySnapshotWhereInput | undefined =
      query.sourceAnalysisId || category
        ? {
            ...(query.sourceAnalysisId && { sourceAnalysisId: query.sourceAnalysisId }),
            ...(category && {
              sourceAnalysis: {
                OR: [
                  { primaryCategoryNodeId: { contains: category } },
                  { primaryCategoryName: { contains: category } },
                  { primaryCategoryPath: { contains: category } },
                ],
              },
            }),
          }
        : undefined
    const where: Prisma.ProductLibraryItemWhereInput = {
      userId,
      ...(query.marketplace && { marketplace: query.marketplace.trim().toUpperCase() }),
      ...(sourceWhere && { snapshots: { some: sourceWhere } }),
      ...(query.minPrice !== undefined || query.maxPrice !== undefined
        ? {
            latestPrice: {
              ...(query.minPrice !== undefined && { gte: query.minPrice }),
              ...(query.maxPrice !== undefined && { lte: query.maxPrice }),
            },
          }
        : {}),
      ...createdAtWhere(query),
      ...(keyword && {
        OR: [
          { asin: { contains: keyword } },
          { title: { contains: keyword } },
          { brand: { contains: keyword } },
          { latestKeyword: { contains: keyword } },
        ],
      }),
    }
    const orderBy: Prisma.ProductLibraryItemOrderByWithRelationInput =
      query.sortBy === ProductLibrarySortBy.COMP_SCORE
        ? { latestCompScore: query.order }
        : query.sortBy === ProductLibrarySortBy.CREATED_AT
          ? { createdAt: query.order }
          : { updatedAt: query.order }

    const [items, total] = await Promise.all([
      this.prisma.productLibraryItem.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          marketplace: true,
          asin: true,
          title: true,
          brand: true,
          imageUrl: true,
          tags: true,
          notes: true,
          latestKeyword: true,
          latestCompScore: true,
          latestPrice: true,
          latestMonthlySales: true,
          latestRatingNum: true,
          createdAt: true,
          updatedAt: true,
          snapshots: {
            orderBy: { updatedAt: "desc" },
            select: {
              sourceAnalysisId: true,
              keyword: true,
              price: true,
              createdAt: true,
              updatedAt: true,
              sourceAnalysis: {
                select: {
                  entry: true,
                  primaryCategoryNodeId: true,
                  primaryCategoryName: true,
                  primaryCategoryPath: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.productLibraryItem.count({ where }),
    ])

    return {
      items: items.map(item => ({
        ...serializeItem(item),
        sources: item.snapshots.map(serializeSource),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async findOne(userId: number, id: number) {
    const item = await this.prisma.productLibraryItem.findFirst({
      where: { id, userId },
      include: {
        snapshots: {
          orderBy: { updatedAt: "desc" },
          include: {
            sourceAnalysis: {
              select: {
                entry: true,
                primaryCategoryNodeId: true,
                primaryCategoryName: true,
                primaryCategoryPath: true,
              },
            },
          },
        },
      },
    })
    if (!item) throw productNotFound()

    return {
      ...serializeItem(item),
      snapshots: item.snapshots.map(snapshot => ({
        id: snapshot.id,
        sourceAnalysisId: snapshot.sourceAnalysisId,
        keyword: snapshot.keyword,
        compScore: decimalToNumber(snapshot.compScore),
        price: decimalToNumber(snapshot.price),
        monthlySales: snapshot.monthlySales,
        ratingNum: snapshot.ratingNum,
        profile: snapshot.profile,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        sourceAnalysis: snapshot.sourceAnalysis,
      })),
    }
  }

  async update(userId: number, id: number, dto: UpdateProductLibraryItemDto) {
    if (dto.tags === undefined && dto.notes === undefined) {
      throw new BadRequestException("请至少提供 tags 或 notes")
    }
    const tags = dto.tags === undefined ? undefined : normalizeTags(dto.tags)
    const result = await this.prisma.productLibraryItem.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        ...(tags !== undefined && { tags: toJson(tags) }),
        ...(dto.notes !== undefined && { notes: dto.notes.trim() }),
      },
    })
    if (result.count === 0) throw productNotFound()
    return this.findOne(userId, id)
  }

  async remove(userId: number, id: number) {
    const result = await this.prisma.productLibraryItem.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (result.count === 0) throw productNotFound()
    this.logger.log(`Product library item deleted: id=${id}, user=${userId}`)
  }

  private async saveItems(userId: number, dtos: CreateProductLibraryItemDto[]) {
    const inputs = dtos.map(normalizeInput)
    assertNoDuplicateSnapshots(inputs)
    const sourceIds = [...new Set(inputs.map(item => item.sourceAnalysisId))]

    const result = await this.prisma.$transaction(
      async tx => {
        const sources = await tx.selectionAnalysisRecord.findMany({
          where: { id: { in: sourceIds }, userId, deletedAt: null },
          select: { id: true },
        })
        const foundSourceIds = new Set(sources.map(item => item.id))
        const missingSourceIds = sourceIds.filter(id => !foundSourceIds.has(id))
        if (missingSourceIds.length > 0) {
          throw new NotFoundException({
            code: "SOURCE_ANALYSIS_NOT_FOUND",
            message: "来源选品分析不存在",
            details: { sourceAnalysisIds: missingSourceIds },
          })
        }

        const items = []
        for (const input of inputs) {
          const createData: Prisma.ProductLibraryItemUncheckedCreateInput = {
            userId,
            marketplace: input.marketplace,
            asin: input.asin ?? null,
            title: input.title,
            brand: input.brand,
            imageUrl: input.imageUrl,
            tags: input.tags === undefined ? undefined : toJson(input.tags),
            notes: input.notes,
            latestKeyword: input.keyword,
            latestCompScore: input.compScore,
            latestPrice: input.price,
            latestMonthlySales: input.monthlySales,
            latestRatingNum: input.ratingNum,
          }
          // 有 ASIN 时沿用商品维度的幂等更新；无 ASIN 时无法可靠识别同一商品，因此创建独立主记录。
          const item = input.asin
            ? await tx.productLibraryItem.upsert({
                where: {
                  userId_marketplace_asin: {
                    userId,
                    marketplace: input.marketplace,
                    asin: input.asin,
                  },
                },
                create: createData,
                update: {
                  deletedAt: null,
                  ...(input.title !== undefined && { title: input.title }),
                  ...(input.brand !== undefined && { brand: input.brand }),
                  ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
                  latestKeyword: input.keyword,
                  latestCompScore: input.compScore ?? null,
                  latestPrice: input.price ?? null,
                  latestMonthlySales: input.monthlySales ?? null,
                  latestRatingNum: input.ratingNum ?? null,
                },
              })
            : await tx.productLibraryItem.create({
                data: createData,
              })

          const compoundKey = {
            itemId: item.id,
            sourceAnalysisId: input.sourceAnalysisId,
            keyword: input.keyword,
          }
          const existingSnapshot = await tx.productLibrarySnapshot.findUnique({
            where: { itemId_sourceAnalysisId_keyword: compoundKey },
          })

          let snapshot = existingSnapshot
          let changed = false
          if (!existingSnapshot) {
            snapshot = await tx.productLibrarySnapshot.create({
              data: {
                ...compoundKey,
                compScore: input.compScore,
                price: input.price,
                monthlySales: input.monthlySales,
                ratingNum: input.ratingNum,
                profile: input.profile,
                profileHash: input.profileHash,
              },
            })
            changed = true
          } else if (existingSnapshot.profileHash !== input.profileHash) {
            snapshot = await tx.productLibrarySnapshot.update({
              where: { id: existingSnapshot.id },
              data: {
                compScore: input.compScore ?? null,
                price: input.price ?? null,
                monthlySales: input.monthlySales ?? null,
                ratingNum: input.ratingNum ?? null,
                profile: input.profile,
                profileHash: input.profileHash,
              },
            })
            changed = true
          }

          if (!snapshot) throw new Error("商品画像快照保存失败")
          items.push({
            id: item.id,
            asin: item.asin,
            marketplace: item.marketplace,
            snapshotId: snapshot.id,
            snapshotChanged: changed,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })
        }
        return { items, count: items.length }
      },
      { timeout: 15_000 }
    )

    this.logger.log(`Product library items saved: count=${result.count}, user=${userId}`)
    return result
  }
}

function normalizeInput(dto: CreateProductLibraryItemDto): NormalizedProductInput {
  const asin = optionalTrim(dto.asin)?.toUpperCase()
  const marketplace = dto.marketplace.trim().toUpperCase()
  const keyword = dto.keyword.trim().replace(/\s+/g, " ")
  if (!marketplace) throw new BadRequestException("marketplace 不能为空")
  if (!keyword) throw new BadRequestException("keyword 不能为空")
  if (!isJsonObject(dto.profile) || Object.keys(dto.profile).length === 0) {
    throw new BadRequestException("profile 必须是非空对象")
  }

  const profile = toJson(dto.profile)
  const profileBytes = Buffer.byteLength(JSON.stringify(profile), "utf8")
  if (profileBytes > PRODUCT_PROFILE_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: "PRODUCT_PROFILE_TOO_LARGE",
      message: "商品画像超过 2 MiB",
      details: { maxBytes: PRODUCT_PROFILE_MAX_BYTES, actualBytes: profileBytes },
    })
  }
  const tags = dto.tags === undefined ? undefined : normalizeTags(dto.tags)
  const snapshotContent = {
    keyword,
    compScore: dto.compScore ?? null,
    price: dto.price ?? null,
    monthlySales: dto.monthlySales ?? null,
    ratingNum: dto.ratingNum ?? null,
    profile,
  }

  return {
    asin,
    marketplace,
    keyword,
    title: optionalTrim(dto.title),
    brand: optionalTrim(dto.brand),
    imageUrl: optionalTrim(dto.imageUrl),
    compScore: dto.compScore,
    price: dto.price,
    monthlySales: dto.monthlySales,
    ratingNum: dto.ratingNum,
    sourceAnalysisId: dto.sourceAnalysisId,
    tags,
    notes: dto.notes?.trim(),
    profile,
    profileHash: hashJson(snapshotContent),
  }
}

function normalizeTags(tags: string[]) {
  const normalized = tags.map(tag => tag.trim())
  if (normalized.some(tag => !tag)) throw new BadRequestException("标签不能为空")
  const keys = normalized.map(tag => tag.toLocaleLowerCase())
  if (new Set(keys).size !== keys.length) throw new BadRequestException("标签不能重复")
  return normalized
}

function assertNoDuplicateSnapshots(inputs: NormalizedProductInput[]) {
  const keys = inputs.map(item =>
    JSON.stringify([
      item.marketplace,
      item.asin ?? `profile:${item.profileHash}`,
      item.sourceAnalysisId,
      item.keyword.toLocaleLowerCase(),
    ])
  )
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestException("批量入库不能包含重复的商品来源画像")
  }
}

function optionalTrim(value?: string) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function decimalToNumber(value: Prisma.Decimal | null | undefined) {
  return value === null || value === undefined ? null : value.toNumber()
}

function assertValidRanges(query: QueryProductLibraryItemDto) {
  if (
    query.minPrice !== undefined &&
    query.maxPrice !== undefined &&
    query.minPrice > query.maxPrice
  ) {
    throw new BadRequestException("最低价格不能高于最高价格")
  }
  if (query.dateFrom && query.dateTo) {
    const from = new Date(query.dateFrom)
    const to = endDate(query.dateTo)
    if (from > to) throw new BadRequestException("起始时间不能晚于结束时间")
  }
}

function createdAtWhere(query: QueryProductLibraryItemDto): {
  createdAt?: Prisma.DateTimeFilter
} {
  if (!query.dateFrom && !query.dateTo) return {}
  const createdAt: Prisma.DateTimeFilter = {}
  if (query.dateFrom) createdAt.gte = new Date(query.dateFrom)
  if (query.dateTo) {
    const end = endDate(query.dateTo)
    if (query.dateTo.includes("T")) createdAt.lte = end
    else createdAt.lt = end
  }
  return { createdAt }
}

function endDate(value: string) {
  const end = new Date(value)
  if (!value.includes("T")) end.setDate(end.getDate() + 1)
  return end
}

function serializeSource(source: {
  sourceAnalysisId: string
  keyword: string
  price: Prisma.Decimal | null
  createdAt: Date
  updatedAt: Date
  sourceAnalysis: {
    entry: string
    primaryCategoryNodeId: string | null
    primaryCategoryName: string | null
    primaryCategoryPath: string | null
  }
}) {
  return {
    sourceAnalysisId: source.sourceAnalysisId,
    keyword: source.keyword,
    price: decimalToNumber(source.price),
    savedAt: source.createdAt,
    updatedAt: source.updatedAt,
    entry: source.sourceAnalysis.entry,
    primaryCategoryNodeId: source.sourceAnalysis.primaryCategoryNodeId,
    primaryCategoryName: source.sourceAnalysis.primaryCategoryName,
    primaryCategoryPath: source.sourceAnalysis.primaryCategoryPath,
  }
}

function serializeItem(item: {
  id: number
  marketplace: string
  asin: string | null
  title: string | null
  brand: string | null
  imageUrl: string | null
  tags: Prisma.JsonValue | null
  notes: string | null
  latestKeyword: string | null
  latestCompScore: Prisma.Decimal | null
  latestPrice: Prisma.Decimal | null
  latestMonthlySales: number | null
  latestRatingNum: number | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: item.id,
    marketplace: item.marketplace,
    asin: item.asin,
    title: item.title,
    brand: item.brand,
    imageUrl: item.imageUrl,
    tags: item.tags,
    notes: item.notes,
    latestKeyword: item.latestKeyword,
    latestCompScore: decimalToNumber(item.latestCompScore),
    latestPrice: decimalToNumber(item.latestPrice),
    latestMonthlySales: item.latestMonthlySales,
    latestRatingNum: item.latestRatingNum,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

function productNotFound() {
  return new NotFoundException({
    code: "PRODUCT_LIBRARY_ITEM_NOT_FOUND",
    message: "商品库记录不存在",
  })
}
