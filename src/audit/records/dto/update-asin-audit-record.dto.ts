import { ApiProperty } from "@nestjs/swagger"
import { IsInt, IsObject, Max, Min } from "class-validator"
import { ASIN_AUDIT_SCHEMA_VERSION } from "../asin-audit-record.constants"

export class UpdateAsinAuditRecordDto {
  @ApiProperty({ example: 1, description: "上一次响应或详情中的主记录 version" })
  @IsInt()
  @Min(1)
  expectedVersion: number

  @ApiProperty({ example: ASIN_AUDIT_SCHEMA_VERSION })
  @IsInt()
  @Min(ASIN_AUDIT_SCHEMA_VERSION)
  @Max(ASIN_AUDIT_SCHEMA_VERSION)
  schemaVersion: number

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "完整 AI 优化结果",
  })
  @IsObject()
  optimizationResult: Record<string, unknown>
}
