import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsNotEmpty, IsString, MaxLength } from "class-validator"
import type { TextGenerationFunction } from "./query-generation-records.dto"
import { GENERATION_FUNCTIONS } from "./query-generation-records.dto"

export class QueryGenerationRecordDetailDto {
  @ApiProperty({
    description: "列表行的完整 key，原样传入，不使用 id 替代",
    example: "TEXT:ASIN_AUDIT:ad648330-78df-4d13-967f-848f140c9c41:score",
  })
  @IsString({ message: "记录标识必须是字符串" })
  @IsNotEmpty({ message: "记录标识不能为空" })
  @MaxLength(256, { message: "记录标识不能超过 256 个字符" })
  key: string
}

export class GenerationRecordDetailDto {
  @ApiPropertyOptional({
    description:
      "智能定价/新品推广计划最终生成步骤优先的实际模型，优先取网关账单模型；缺少运行记录时为 null",
    nullable: true,
  })
  actualModel?: string | null

  @ApiPropertyOptional({
    description:
      "智能定价/新品推广计划该报告所有已完成 AI 步骤的实际模型，去重；不包含 fixed-module",
    type: [String],
  })
  actualModels?: string[]

  @ApiPropertyOptional({ description: "ASIN 审计或取证主报告 ID" })
  recordId?: string

  @ApiPropertyOptional({ description: "ASIN 生成阶段", enum: ["score", "optimize", "evidence"] })
  operation?: "score" | "optimize" | "evidence"

  @ApiPropertyOptional({
    description: "当前 ASIN 阶段的实扣积分；无可关联台账时为 null",
    nullable: true,
  })
  credits?: string | null

  @ApiPropertyOptional({ description: "当前 ASIN 阶段使用的模型", type: [String] })
  models?: string[]

  @ApiProperty({ description: "对应列表行的 key" })
  key: string

  @ApiProperty({
    description: "具体文本功能",
    enum: GENERATION_FUNCTIONS.filter(f => !["IMAGE", "VIDEO", "INSPIRATION_RADAR"].includes(f)),
  })
  function: TextGenerationFunction

  @ApiProperty({ description: "功能展示名", example: "ASIN 审计" })
  functionLabel: string

  @ApiProperty({ enum: ["TEXT"] })
  contentType: "TEXT"

  @ApiProperty({ description: "正文归属用户，不限定为当前管理员本人" })
  userId: number

  @ApiProperty({ description: "来源记录的当前状态" })
  status: string

  @ApiProperty({ description: "记录是否已软删除；已删除记录不返回正文" })
  deleted: boolean

  @ApiProperty({ description: "创建时间（ISO8601）" })
  createdAt: string

  @ApiProperty({ description: "是否有可展示正文" })
  available: boolean

  @ApiProperty({ enum: ["JSON", "TEXT"], nullable: true, description: "正文格式；无正文时为 null" })
  format: "JSON" | "TEXT" | null

  @ApiProperty({
    nullable: true,
    description: "JSON 结构化正文或纯文本；具体结构随 function 和记录来源变化。无正文时为 null。",
    oneOf: [
      { type: "object", additionalProperties: true },
      { type: "array", items: {} },
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
    ],
  })
  content: unknown

  @ApiProperty({ nullable: true, description: "正文不可用的中文说明；有正文时为 null" })
  message: string | null
}
