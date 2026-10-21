import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsInt, IsObject, IsOptional, Max, Min } from "class-validator"
import { MAX_PICK_COUNT } from "../product-selection.constants"

export class SaveAnalysisStepDto {
  @ApiProperty({ example: 3, description: "上一次响应或详情中的主记录 version" })
  @IsInt()
  @Min(1)
  expectedVersion: number

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Max(1)
  schemaVersion: number

  @ApiProperty({ example: {} })
  @IsObject()
  payload: Record<string, unknown>

  @ApiPropertyOptional({ example: 4, description: "仅第5步使用" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PICK_COUNT)
  pickCount?: number
}
