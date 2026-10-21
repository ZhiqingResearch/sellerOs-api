import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator"
import { FIXED_MODULE_CREDITS, type FixedModuleSource } from "../fixed-module-credits"

export class FixedModulePrecheckDto {
  @ApiPropertyOptional({ description: "类目数量（最多5个，每个80积分）或竞品数量（最多3个，每个25积分）；其他模块忽略", minimum: 1, maximum: 5, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  quantity?: number

  @ApiProperty({ enum: Object.keys(FIXED_MODULE_CREDITS), example: "listing.generate" })
  @IsIn(Object.keys(FIXED_MODULE_CREDITS))
  source!: FixedModuleSource

  @ApiPropertyOptional({ enum: ["optimization"], example: "optimization" })
  @IsOptional()
  @IsIn(["optimization"])
  operation?: "optimization"

  @ApiPropertyOptional({ description: "Listing 同一次生成的计费 UUID，两个方案共用" })
  @IsOptional()
  @IsUUID()
  generationBillingId?: string
}
