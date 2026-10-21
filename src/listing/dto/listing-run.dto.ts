import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator"

export class CreateListingRunDto {
  @ApiProperty({ description: "同一产品工作流的 UUID" })
  @IsUUID()
  runId!: string

  @ApiProperty({ description: "用户输入的产品名称" })
  @IsString()
  @MaxLength(500)
  title!: string
}

export class UpdateListingRunDto {
  @ApiPropertyOptional({ description: "本次生成尝试的 UUID，用于断线恢复及隔离迟到响应" })
  @IsOptional()
  @IsUUID()
  attemptId?: string

  @ApiPropertyOptional({ enum: [0, 1], description: "保存单个方案时的索引，避免并行方案互相覆盖" })
  @IsOptional()
  @IsIn([0, 1])
  planIndex?: number

  @ApiProperty({ enum: ["RUNNING", "COMPLETED", "PARTIAL", "FAILED"] })
  @IsIn(["RUNNING", "COMPLETED", "PARTIAL", "FAILED"])
  status!: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED"

  @ApiProperty({ description: "业务阶段，如 generation / result_validation / completed" })
  @IsString()
  @MaxLength(50)
  stage!: string

  @ApiPropertyOptional({ description: "终态错误（不含凭证）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  error?: string

  @ApiPropertyOptional({ description: "已校验的历史报告数据，兼容 params / plans 结构" })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>
}
