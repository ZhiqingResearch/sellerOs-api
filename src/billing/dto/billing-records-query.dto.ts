import { ApiPropertyOptional } from "@nestjs/swagger"
import { BillingOrderType, PaymentChannel } from "@prisma/client"
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class BillingRecordsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "创建时间下限（含），前端按展示时区换算为带时区的 ISO 时间" })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  startDate?: string

  @ApiPropertyOptional({ description: "创建时间上限（含），所选结束日期的日末" })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  endDate?: string

  @ApiPropertyOptional({ enum: BillingOrderType })
  @IsOptional()
  @IsEnum(BillingOrderType)
  type?: BillingOrderType

  @ApiPropertyOptional({ enum: ["STRIPE", "ALLINPAY"], description: "海外 / 国内支付" })
  @IsOptional()
  @IsIn(["STRIPE", "ALLINPAY"])
  provider?: "STRIPE" | "ALLINPAY"

  @ApiPropertyOptional({ enum: PaymentChannel })
  @IsOptional()
  @IsEnum(PaymentChannel)
  channel?: PaymentChannel

  @ApiPropertyOptional({ description: "CSV 时间展示时区，缺省为 Asia/Shanghai" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tz?: string
}
