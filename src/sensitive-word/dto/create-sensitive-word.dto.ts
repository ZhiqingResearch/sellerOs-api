import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { SensitiveWordRiskLevel, SensitiveWordSource } from "@prisma/client"
import { Transform } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator"

export class CreateSensitiveWordDto {
  @ApiProperty({
    example: ["FDA approved", "USDA"],
    description:
      "敏感词数组（前端按英文逗号拆好后传入）。后端会 trim 前后空格、过滤空串、去重；单个 1-255 字，最多 100 个",
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  word!: string[]

  @ApiProperty({
    example: "amazon",
    description: "平台标识，小写字符串。当前常见值：amazon / walmart",
  })
  @IsString()
  @MaxLength(50)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  platform!: string

  @ApiProperty({
    example: ["保健品", "美容"],
    description: "商品分类数组（自由文本，可多选），至少 1 个，每个 1-100 字",
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  category!: string[]

  @ApiProperty({
    enum: SensitiveWordRiskLevel,
    example: SensitiveWordRiskLevel.HIGH,
    description: "风险等级：LOW / MEDIUM / HIGH",
  })
  @IsEnum(SensitiveWordRiskLevel)
  riskLevel!: SensitiveWordRiskLevel

  @ApiPropertyOptional({
    example: "可使用「品质保障」等替代说法",
    description: "建议替代 / 风险说明",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  suggestion?: string

  @ApiPropertyOptional({
    enum: SensitiveWordSource,
    example: SensitiveWordSource.LISTING_GENERATION,
    description: "来源：MANUAL（默认）/ LISTING_GENERATION / AI_DETECTION；不传则按 MANUAL 入库",
  })
  @IsOptional()
  @IsEnum(SensitiveWordSource)
  source?: SensitiveWordSource
}
