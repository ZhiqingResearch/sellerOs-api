import { BadRequestException } from "@nestjs/common"
import { ApiProperty } from "@nestjs/swagger"
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn } from "class-validator"

/** 工具箱历史记录页签类型 → 后端记录表映射（侵权风险排查后端暂无模块，不在枚举内） */
export const TOOLBOX_RECORD_TYPES = [
  "listing_generation",
  "listing_scoring",
  "asin_evidence",
  "asin_audit",
  "competitor_analysis",
  "product_selection",
  "smart_pricing",
  "ad_cleaning",
  "promotion_plan",
] as const

export type ToolboxRecordType = (typeof TOOLBOX_RECORD_TYPES)[number]

/** 数字 id 类型（History 表：Listing 生成 / 打分），其余类型为 UUID 字符串（ad_cleaning 为 taskId） */
export const NUMERIC_ID_TYPES: readonly ToolboxRecordType[] = [
  "listing_generation",
  "listing_scoring",
]

export class BatchDeleteRecordsDto {
  @ApiProperty({
    enum: TOOLBOX_RECORD_TYPES,
    example: "asin_audit",
    description: "记录类型",
  })
  @IsIn(TOOLBOX_RECORD_TYPES as readonly string[])
  type!: ToolboxRecordType

  @ApiProperty({
    example: ["23fd58d7-3810-4a16-8a39-61520e134994"],
    description:
      "待删除记录 id 数组，1~100 个，自动去重；listing_generation/listing_scoring 为数字 id，其余为 UUID 字符串（ad_cleaning 传 taskId）",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  ids!: (number | string)[]
}

/** service 内防御性校验：数字 id 类型要求正整数 */
export function assertNumericIds(type: ToolboxRecordType, ids: unknown[]): void {
  const bad = ids.some(id => typeof id !== "number" || !Number.isInteger(id) || id <= 0)
  if (bad) throw new BadRequestException(`${type} 的 ids 必须为正整数`)
}

/** service 内防御性校验：字符串 id 类型要求非空且 ≤36 字符 */
export function assertStringIds(type: ToolboxRecordType, ids: unknown[]): void {
  const bad = ids.some(id => typeof id !== "string" || !id.trim() || id.length > 36)
  if (bad) throw new BadRequestException(`${type} 的 ids 必须为 36 字符以内的非空字符串`)
}
