import { ApiProperty } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { ASIN_AUDIT_SCHEMA_VERSION } from "../asin-audit-record.constants"

export class AsinAuditCategoryDto {
  @ApiProperty({ example: "172282", description: "类目节点 ID" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nodeId: string

  @ApiProperty({ example: "Electronics", description: "类目名称" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name: string

  @ApiProperty({
    example: "Electronics:Wearable Technology:Smart Glasses",
    description: "类目完整路径",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  path: string
}

export class CreateAsinAuditRecordDto {
  @ApiProperty({ example: "23fd58d7-3810-4a16-8a39-61520e134994" })
  @IsUUID("4")
  clientRequestId: string

  @ApiProperty({ example: ASIN_AUDIT_SCHEMA_VERSION })
  @IsInt()
  @Min(ASIN_AUDIT_SCHEMA_VERSION)
  @Max(ASIN_AUDIT_SCHEMA_VERSION)
  schemaVersion: number

  @ApiProperty({ example: "B0C9L8ZR6Q" })
  @IsString()
  @Matches(/^[A-Z0-9]{10}$/i, { message: "asin 需为 10 位字母数字" })
  asin: string

  @ApiProperty({ example: "US", description: "电商站点代码" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  marketplace: string

  @ApiProperty({ example: "US", description: "国家或地区代码" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  country: string

  @ApiProperty({ type: AsinAuditCategoryDto })
  @ValidateNested()
  @Type(() => AsinAuditCategoryDto)
  category: AsinAuditCategoryDto

  @ApiProperty({ example: "Example Smart Glasses" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  productTitle: string

  @ApiProperty({ example: false, description: "是否包含广告数据" })
  @IsBoolean()
  adIncluded: boolean

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "A/P/B/C/D/E 六卡证据及 meta",
  })
  @IsObject()
  evidence: Record<string, unknown>

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "完整十维评分、criteria、问题及建议",
  })
  @IsObject()
  scoreResult: Record<string, unknown>
}
