import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsInt, IsOptional } from "class-validator"

export class RefreshDto {
  @ApiPropertyOptional({ example: 1, description: "订阅 ID，不传则刷新全部" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  id?: number
}
