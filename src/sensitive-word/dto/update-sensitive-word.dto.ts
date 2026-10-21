import { ApiPropertyOptional, OmitType, PartialType } from "@nestjs/swagger"
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator"
import { CreateSensitiveWordDto } from "./create-sensitive-word.dto"

/**
 * 更新单条敏感词。继承 Create 的可选字段，但 word 单独覆盖为 string 单值：
 * 创建支持批量数组，更新只针对单条记录，不允许批量改 word。
 */
export class UpdateSensitiveWordDto extends PartialType(
  OmitType(CreateSensitiveWordDto, ["word"] as const)
) {
  @ApiPropertyOptional({ example: "FDA approved", description: "敏感词文本，1-255 字" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  word?: string
}
