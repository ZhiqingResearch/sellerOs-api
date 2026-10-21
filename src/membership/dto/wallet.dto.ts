import { ApiPropertyOptional } from "@nestjs/swagger"
import { InvokeType } from "@prisma/client"
import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import {
  CONSUME_SOURCE_OPTIONS,
  INVOKE_TYPE_OPTIONS,
  type ConsumeSource,
} from "../transaction-options"

/** 扣费来源合法值：与 transaction-options.consumeSources 同源（去掉「全部」空串项），永不漂移 */
const CONSUME_SOURCE_VALUES = CONSUME_SOURCE_OPTIONS.map(o => o.value).filter(
  (v): v is ConsumeSource => v !== ""
)

/** 调用方式合法值：与 transaction-options.invokeTypes 同源（去掉「全部」空串项），永不漂移 */
const INVOKE_TYPE_VALUES = INVOKE_TYPE_OPTIONS.map(o => o.value).filter(
  (v): v is InvokeType => v !== ""
)

/** 积分明细查询：按方向（使用/充值）、桶、类型筛选 */
export class QueryTransactionsDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ["CREDIT", "DEBIT"],
    description: "方向：CREDIT=入账(充值/返利) / DEBIT=出账(消费/清零)",
  })
  @IsOptional()
  @IsIn(["CREDIT", "DEBIT"])
  direction?: "CREDIT" | "DEBIT"

  @ApiPropertyOptional({ enum: ["RECHARGE", "PACKAGE", "GIFT", "REBATE"], description: "积分桶" })
  @IsOptional()
  @IsIn(["RECHARGE", "PACKAGE", "GIFT", "REBATE"])
  bucket?: "RECHARGE" | "PACKAGE" | "GIFT" | "REBATE"

  @ApiPropertyOptional({
    enum: [
      "RECHARGE_PLAN",
      "RECHARGE_PACK",
      "RECHARGE_CUSTOM",
      "SIGNUP_BONUS",
      "MANUAL_ADJUST",
      "GIFT_COMPENSATE", // 伪类型「赠送」：正向补偿发放（与手动调整互斥拆分）
      "CONSUME",
      "EXPIRE",
      "REBATE_IN",
      "REBATE_WITHDRAW",
    ],
    description: "流水类型",
  })
  @IsOptional()
  @IsIn([
    "RECHARGE_PLAN",
    "RECHARGE_PACK",
    "RECHARGE_CUSTOM",
    "SIGNUP_BONUS",
    "MANUAL_ADJUST",
    "GIFT_COMPENSATE",
    "CONSUME",
    "EXPIRE",
    "REBATE_IN",
    "REBATE_WITHDRAW",
  ])
  type?: string

  @ApiPropertyOptional({
    example: "listing",
    description: "功能模块：按消费来源 source 子串筛选（source 为各业务自由标识，非枚举）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string

  @ApiPropertyOptional({ example: "2026-06-01T00:00:00.000Z", description: "起始时间（含，ISO）" })
  @IsOptional()
  @IsDateString()
  startDate?: string

  @ApiPropertyOptional({ example: "2026-06-30T23:59:59.999Z", description: "结束时间（含，ISO）" })
  @IsOptional()
  @IsDateString()
  endDate?: string

  @ApiPropertyOptional({
    enum: ["PERSONAL", "TEAM"],
    description: "积分归属：PERSONAL=个人批次（teamId 空）/ TEAM=企业共享池批次（teamId 有值）",
  })
  @IsOptional()
  @IsIn(["PERSONAL", "TEAM"])
  ownership?: "PERSONAL" | "TEAM"

  @ApiPropertyOptional({
    enum: CONSUME_SOURCE_VALUES,
    description:
      "扣费来源细分（个人/邀请人/企业各桶，与筛选项同枚举）；见 transaction-options.consumeSources",
  })
  @IsOptional()
  @IsIn(CONSUME_SOURCE_VALUES)
  consumeSource?: ConsumeSource

  @ApiPropertyOptional({
    enum: INVOKE_TYPE_VALUES,
    description:
      "调用方式：PLATFORM=平台使用（默认）/ API=开放平台扣费；见 transaction-options.invokeTypes",
  })
  @IsOptional()
  @IsIn(INVOKE_TYPE_VALUES)
  invokeType?: InvokeType

  @ApiPropertyOptional({
    example: "self",
    description:
      "【邀请人 LV5 专用】使用用户筛选：'self'=本人；或某下级 userId（字符串）；见 transaction-options.consumers",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  consumerUserId?: string
}
