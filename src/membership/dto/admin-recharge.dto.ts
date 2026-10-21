import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

const RECHARGE_TXN_TYPE_ENUM = [
  "RECHARGE_PLAN",
  "RECHARGE_PACK",
  "RECHARGE_CUSTOM",
  "MANUAL_ADJUST",
  "SIGNUP_BONUS", // 注册赠送（与 RECHARGE_TXN_TYPES 默认口径保持一致）
  "GIFT_COMPENSATE", // 伪类型「赠送」：MANUAL_ADJUST 中的正向补偿发放（与手动调整筛选互斥拆分）
] as const

export class ChargePlanDto {
  @ApiProperty({ example: 12, description: "目标用户 id" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  userId: number

  @ApiProperty({ example: 2, description: "会员档位（1=Explorer / 2=Plus / 3=Ultra）" })
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3])
  tier: number
}

export class ChargePackDto {
  @ApiProperty({ example: 12, description: "目标用户 id" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  userId: number

  @ApiProperty({ example: 2, description: "充值包 id" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  packId: number
}

export class ChargeCustomDto {
  @ApiProperty({ example: 12, description: "目标用户 id" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  userId: number

  @ApiProperty({
    example: 200,
    description: "自定义充值金额（元，≥1）；本金进充值积分、按档赠送进套餐积分",
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amountCny: number
}

export class ManualAdjustDto {
  @ApiProperty({ example: 12, description: "目标用户 id" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  userId: number

  @ApiProperty({
    example: 500,
    description:
      "调整积分（非 0）：正=增加(进充值积分桶、永不过期)；负=扣减(只扣充值积分 RECHARGE、不动赠送，可用不足报 400)",
  })
  @Type(() => Number)
  @IsInt()
  amount: number

  @ApiPropertyOptional({ example: "客诉补偿", description: "调整说明（留档）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string
}

export class RechargeFlagDto {
  @ApiProperty({
    example: true,
    description: "是否允许该账号进行后台充值（账号级白名单，连超管也需显式开）",
  })
  @IsBoolean()
  canRecharge: boolean
}

export class QueryRechargeUsersDto extends PaginationDto {
  @ApiPropertyOptional({ description: "用户名 / 手机号关键词" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({
    enum: ["inviter", "invited", "none"],
    description:
      "邀请状态：inviter=可邀请（canInvite=true 或返利余额>0，2026-08-31 起）/ invited=被邀请 / none=未开启",
  })
  @IsOptional()
  @IsIn(["inviter", "invited", "none"])
  inviteStatus?: "inviter" | "invited" | "none"

  @ApiPropertyOptional({
    enum: ["NONE", "LV1", "LV2", "LV3", "FOUNDER", "INVITER"],
    description: "按会员等级筛选",
  })
  @IsOptional()
  @IsIn(["NONE", "LV1", "LV2", "LV3", "FOUNDER", "INVITER"])
  level?: string

  @ApiPropertyOptional({ description: "所属组织 id" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  orgId?: number

  @ApiPropertyOptional({
    enum: ["points", "level"],
    description: "排序字段，默认 points（剩余积分）",
  })
  @IsOptional()
  @IsIn(["points", "level"])
  sortBy?: "points" | "level"

  @ApiPropertyOptional({ enum: ["asc", "desc"], description: "排序方向，默认 desc" })
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortDir?: "asc" | "desc"
}

export class QueryRechargeTransactionsDto extends PaginationDto {
  @ApiPropertyOptional({ example: 12, description: "按用户 id 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number

  @ApiPropertyOptional({
    enum: RECHARGE_TXN_TYPE_ENUM,
    description: "充值类型；不传默认含套餐/充值包/自定义/手动调额/注册赠送全部",
  })
  @IsOptional()
  @IsIn(RECHARGE_TXN_TYPE_ENUM)
  type?: (typeof RECHARGE_TXN_TYPE_ENUM)[number]

  @ApiPropertyOptional({ example: "2026-06-01T00:00:00.000Z", description: "起始时间（含，ISO）" })
  @IsOptional()
  @IsDateString()
  startDate?: string

  @ApiPropertyOptional({ example: "2026-06-30T23:59:59.999Z", description: "结束时间（含，ISO）" })
  @IsOptional()
  @IsDateString()
  endDate?: string
}

export class AdminRebateWithdrawDto {
  @ApiProperty({ example: 12, description: "目标邀请人（LV5）用户 id" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  userId: number

  @ApiProperty({ example: 500, description: "代发提现积分（>0，不超过该用户可提现返利）" })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  amount: number

  @ApiPropertyOptional({ example: "线下已打款支付宝", description: "代发说明（留档）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string
}
