import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsOptional, IsString } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryRecordDto extends PaginationDto {
  @ApiPropertyOptional({ example: "榨汁", description: "按记录名称模糊搜索" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({
    example: "competitor",
    description: "来源类型精确匹配",
    enum: ["competitor", "own_product", "selection", "inspiration"],
  })
  @IsOptional()
  @IsIn(["competitor", "own_product", "selection", "inspiration"])
  sourceType?: string

  @ApiPropertyOptional({
    example: "in_progress",
    description: "状态精确匹配",
    enum: ["draft", "in_progress", "completed"],
  })
  @IsOptional()
  @IsIn(["draft", "in_progress", "completed"])
  status?: string
}
