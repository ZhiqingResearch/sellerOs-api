import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateIf,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

/** 后台更新全局返利规则（单行，upsert id=1）；全部可选，但至少传一项 */
export class UpdateRebateRulesDto {
  @ApiPropertyOptional({ example: true, description: "企业成员消耗走企业池时是否计入返利" })
  @IsOptional()
  @IsBoolean()
  corpCounts?: boolean

  @ApiPropertyOptional({
    example: 2,
    description: "返利层数（1~5 整数）；传 null 表示不限层级（沿邀请链上溯到底）",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateRebateRulesDto) => o.maxLayers !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxLayers?: number | null

  @ApiPropertyOptional({
    example: 5000,
    description: "邀请人单月返利封顶（积分，正整数）；传 null 表示不限",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateRebateRulesDto) => o.perInviterCap !== null)
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  perInviterCap?: number | null

  @ApiPropertyOptional({
    example: 0.5,
    description: "单笔返利占消耗比例上限（0~1 小数）；传 null 表示不限",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateRebateRulesDto) => o.perConsumeCapPct !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  perConsumeCapPct?: number | null
}

/** 分销关系树查询：userId 必填；page/pageSize 用于一级成员内嵌的二级列表分页 */
export class QueryDistTreeDto extends PaginationDto {
  @ApiProperty({ example: 12, description: "分销树根用户 ID" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number

  @ApiPropertyOptional({
    enum: ["all", "inviter", "team", "personal"],
    description:
      "成员范围筛选（2026-08-31 补）：all=全部（默认）；inviter=仅可邀请（本人 canInvite 或一级成员经上级" +
      "「下级可继续邀请」派生，二级无向下派生）；team=仅已进企业（占用中成员：ACTIVE/DISABLED + ACTIVE/GRACE 团队）；personal=仅个人计费。" +
      "不匹配的一级成员若含匹配的二级成员仍保留作上下文，其 level2 列表/level2Total 按筛选后计。",
  })
  @IsOptional()
  @IsIn(["all", "inviter", "team", "personal"])
  scope?: "all" | "inviter" | "team" | "personal"
}

/** 运营侧被邀注册申请队列查询（admin/dist/applications） */
export class QueryAdminApplicationsDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ["PENDING", "APPROVED", "REJECTED"],
    description: "申请状态筛选（缺省全部；审批队列传 PENDING）",
  })
  @IsOptional()
  @IsIn(["PENDING", "APPROVED", "REJECTED"])
  status?: "PENDING" | "APPROVED" | "REJECTED"

  @ApiPropertyOptional({ description: "按申请人用户名/邮箱/手机号或邀请人用户名模糊搜索" })
  @IsOptional()
  @IsString()
  keyword?: string
}
