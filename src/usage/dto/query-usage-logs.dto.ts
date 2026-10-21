import { ApiPropertyOptional } from "@nestjs/swagger"
import { UsageType } from "@prisma/client"
import { IsEnum, IsOptional } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryUsageLogsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: UsageType, description: "筛选类型：TOKEN / MCP" })
  @IsOptional()
  @IsEnum(UsageType)
  type?: UsageType
}
