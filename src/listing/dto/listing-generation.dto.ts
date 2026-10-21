import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { ListingAiInvocationDto } from "./listing-ai.dto"

export class CreateListingGenerationDto {
  @ApiProperty({ description: "工作流 UUID" })
  @IsUUID()
  runId!: string

  @ApiProperty({ description: "生成尝试 UUID，重复提交不再次请求模型" })
  @IsUUID()
  attemptId!: string

  @ApiPropertyOptional({ description: "同一次生成两个方案共用的计费 UUID，省略时使用工作流 UUID" })
  @IsOptional()
  @IsUUID()
  generationBillingId?: string

  @ApiProperty({ enum: [0, 1] })
  @IsIn([0, 1])
  planIndex!: number

  @ApiProperty({ type: ListingAiInvocationDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ListingAiInvocationDto)
  main!: ListingAiInvocationDto

  @ApiPropertyOptional({ type: ListingAiInvocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingAiInvocationDto)
  longTitle?: ListingAiInvocationDto

  @ApiProperty({ description: "纯数据的规则上下文快照，禁止包含凭证" })
  @IsObject()
  context!: Record<string, unknown>
}

export class FinishListingGenerationDto {
  @ApiPropertyOptional({ description: "生成流程的自动评分请求，与正文共同持久化后后台执行", type: ListingAiInvocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingAiInvocationDto)
  autoScore?: ListingAiInvocationDto

  @ApiProperty({ enum: ["COMPLETED", "PARTIAL", "FAILED"] })
  @IsIn(["COMPLETED", "PARTIAL", "FAILED"])
  status!: "COMPLETED" | "PARTIAL" | "FAILED"

  @ApiPropertyOptional({ description: "经平台规则验证的完整报告；部分结果不传此字段" })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>

  @ApiPropertyOptional({ description: "本地解析/校验失败说明" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  error?: string
}
