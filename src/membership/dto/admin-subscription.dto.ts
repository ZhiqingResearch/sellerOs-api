import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

/** 个人订阅列表查询：状态/档位/关键词/到期日区间 + 分页 */
export class QueryAdminSubscriptionDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按用户名 / 手机号模糊搜索" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({ enum: [1, 2, 3], description: "订阅档位筛选（Lv.1/2/3）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3])
  tier?: 1 | 2 | 3

  @ApiPropertyOptional({
    enum: ["ACTIVE", "EXPIRING", "EXPIRED"],
    description:
      "订阅状态：ACTIVE=在期（全部未过期，含临期）/ EXPIRING=7 天内到期（在期子集）/ EXPIRED=已过期",
  })
  @IsOptional()
  @IsIn(["ACTIVE", "EXPIRING", "EXPIRED"])
  status?: "ACTIVE" | "EXPIRING" | "EXPIRED"

  @ApiPropertyOptional({
    example: "2026-09-01T00:00:00.000Z",
    description: "到期日区间-起（ISO，含）",
  })
  @IsOptional()
  @IsDateString()
  expiresStart?: string

  @ApiPropertyOptional({
    example: "2026-09-30T23:59:59.999Z",
    description: "到期日区间-止（ISO，含）",
  })
  @IsOptional()
  @IsDateString()
  expiresEnd?: string
}

/** 客服补偿调整：赠送积分（可负数扣回）/ 延长有效期；至少传一项。不产生订单、不开收据 */
export class AdjustSubscriptionDto {
  @ApiPropertyOptional({
    example: 500,
    description: "赠送积分变动：正=发放（GIFT 桶，30 天过期）；负=按过期先后扣回，不得超剩余",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  giftCredits?: number

  @ApiPropertyOptional({ example: 30, description: "延长有效期天数（在当前到期时刻上顺延）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  extendDays?: number

  @ApiPropertyOptional({ example: "客户投诉补偿", description: "备注（写入充值记录 meta.reason）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string
}

// ==================== 响应结构（Swagger @ApiResponse 用；与 service 实际返回一致） ====================

export class AdminSubscriptionItemDto {
  @ApiProperty({ example: 21 })
  userId: number
  @ApiProperty({ example: "小李" })
  username: string
  @ApiProperty({ example: "138****1234", description: "脱敏手机号" })
  phone: string
  @ApiProperty({ example: "li@example.com", nullable: true })
  email: string | null
  @ApiProperty({ example: 2, nullable: true, description: "会员档位 1/2/3" })
  tier: number | null
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z", nullable: true })
  subscriptionExpiresAt: string | null
  @ApiProperty({ enum: ["ACTIVE", "EXPIRING", "EXPIRED"], example: "EXPIRING" })
  status: "ACTIVE" | "EXPIRING" | "EXPIRED"
  @ApiProperty({ example: 4, nullable: true, description: "剩余天数（已过期为负）" })
  daysLeft: number | null
  @ApiProperty({ example: "1250", description: "剩余积分（个人可消费=充值+套餐+赠送，字符串）" })
  points: string
}

export class AdminSubscriptionSummaryTierDto {
  @ApiProperty({ example: 2 })
  tier: number
  @ApiProperty({ example: "Plus", nullable: true })
  planName: string | null
  @ApiProperty({ example: 399, nullable: true, description: "档月价（元）；未定价为 null" })
  priceCny: number | null
  @ApiProperty({ example: 30 })
  total: number
  @ApiProperty({ example: 21 })
  active: number
  @ApiProperty({ example: 3 })
  expiring: number
  @ApiProperty({ example: 9 })
  expired: number
  @ApiProperty({ example: 8379 })
  mrrCny: number
}

export class AdminSubscriptionSummaryDto {
  @ApiProperty({ example: "CNY" })
  currency: string
  @ApiProperty({ example: 12900 })
  mrrCny: number
  @ApiProperty({ example: 42 })
  activeSubscribers: number
  @ApiProperty({ example: 5 })
  expiringSoon: number
  @ApiProperty({ type: [AdminSubscriptionSummaryTierDto] })
  byTier: AdminSubscriptionSummaryTierDto[]
}

export class AdminSubscriptionListResponseDto {
  @ApiProperty({ type: [AdminSubscriptionItemDto] })
  items: AdminSubscriptionItemDto[]
  @ApiProperty({ example: 57 })
  total: number
  @ApiProperty({ example: 1 })
  page: number
  @ApiProperty({ example: 10 })
  pageSize: number
  @ApiProperty({ type: AdminSubscriptionSummaryDto })
  summary: AdminSubscriptionSummaryDto
}
