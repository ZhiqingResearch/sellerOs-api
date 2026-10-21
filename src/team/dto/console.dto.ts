import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator"

/** 添加成员：已存在账号（手机号/邮箱）直接拉入；不存在的手机号则开新账号 */
export class AddMemberDto {
  @ApiProperty({
    example: "13800138000",
    description: "成员账号：手机号；或已注册账号的邮箱（邮箱仅支持拉入已存在账号）",
  })
  @IsString()
  @MaxLength(120)
  account: string

  @ApiPropertyOptional({ example: "张三", description: "姓名（新建账号时用，缺省取账号）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  username?: string

  @ApiPropertyOptional({
    example: "Abcd1234",
    description: "初始密码（新建账号必填，至少 6 位；成员首次登录后需自行修改）",
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  initialPassword?: string
}

/** 设为管理员 / 设为成员 */
export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ["ADMIN", "MEMBER"], description: "ADMIN=移交管理员 / MEMBER=设为成员" })
  @IsIn(["ADMIN", "MEMBER"])
  role: "ADMIN" | "MEMBER"
}

/** 停用 / 启用成员 */
export class UpdateMemberStatusDto {
  @ApiProperty({ enum: ["ACTIVE", "DISABLED"], description: "成员状态" })
  @IsIn(["ACTIVE", "DISABLED"])
  status: "ACTIVE" | "DISABLED"
}

/** 调整成员月度上限（SHARED=封顶 / INDEPENDENT=固定配额；null=不限） */
export class UpdateMemberQuotaDto {
  @ApiProperty({ example: 5000, description: "月度上限（积分）；传 null 表示不限", nullable: true })
  @ValidateIf((o: UpdateMemberQuotaDto) => o.monthlyQuota !== null)
  @IsInt()
  @Min(1)
  monthlyQuota: number | null
}

/** 批量分配月度上限（统一设置，不覆盖管理员） */
export class BatchQuotaDto {
  @ApiProperty({
    example: 5000,
    description: "统一设置的月度上限（积分）；传 null 表示不限",
    nullable: true,
  })
  @ValidateIf((o: BatchQuotaDto) => o.monthlyQuota !== null)
  @IsInt()
  @Min(1)
  monthlyQuota: number | null
}

/** 设置与日志-企业信息/积分模式（至少传一项） */
export class UpdateSettingsDto {
  @ApiPropertyOptional({ example: "星辰科技", description: "企业名称" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @ApiPropertyOptional({
    enum: ["SHARED", "INDEPENDENT"],
    description: "积分模式：共享池 / 独立配额",
  })
  @IsOptional()
  @IsIn(["SHARED", "INDEPENDENT"])
  quotaMode?: "SHARED" | "INDEPENDENT"

  @ApiPropertyOptional({
    enum: ["BLOCK", "WARN"],
    description: "超额策略（仅共享池模式）：阻止 / 仅提醒",
  })
  @IsOptional()
  @IsIn(["BLOCK", "WARN"])
  overLimitPolicy?: "BLOCK" | "WARN"
}

/** 模型配置-全局默认（批量保存时三项必填，须为对应类型的在架模型） */
export class ModelDefaultsDto {
  @ApiProperty({ example: "gemini-2.5-flash", description: "文本/分析类默认模型" })
  @IsString()
  @MaxLength(50)
  text: string

  @ApiProperty({ example: "nano-banana-2", description: "生图类默认模型" })
  @IsString()
  @MaxLength(50)
  image: string

  @ApiProperty({ example: "veo-3.1-lite", description: "生视频类默认模型" })
  @IsString()
  @MaxLength(50)
  video: string
}

/** 模型配置-单个功能模块（批量保存条目，moduleKey 须覆盖注册表全部模块） */
export class ModuleModelItemDto {
  @ApiProperty({ example: "listing", description: "功能模块标识（见 GET /team/models 注册表）" })
  @IsString()
  @MaxLength(50)
  moduleKey: string

  @ApiProperty({
    example: ["gemini-2.5-flash", "gemini-3.1-pro-preview"],
    description: "可选模型范围（至少一个，须在架且模型类型与模块匹配）",
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  allowedModels: string[]

  @ApiProperty({ example: "gemini-2.5-flash", description: "默认模型（须在可选范围内）" })
  @IsString()
  @MaxLength(50)
  defaultModel: string

  @ApiProperty({ example: true, description: "成员是否可在可选范围内自选模型" })
  @IsBoolean()
  memberSelectable: boolean
}

/** 模型配置-批量保存：整页一次提交（全局默认 + 全部功能模块），单事务整体生效 */
export class BatchSaveModelsDto {
  @ApiProperty({ type: ModelDefaultsDto })
  @ValidateNested()
  @Type(() => ModelDefaultsDto)
  defaults: ModelDefaultsDto

  @ApiProperty({ type: [ModuleModelItemDto], description: "必须恰好覆盖注册表全部功能模块" })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModuleModelItemDto)
  modules: ModuleModelItemDto[]
}

/** 用量分析查询：维度 + 时间区间（缺省本月至今） */
export class QueryUsageDto {
  @ApiPropertyOptional({
    enum: ["member", "source", "model"],
    description: "聚合维度：成员 / 功能 / 模型",
    default: "member",
  })
  @IsOptional()
  @IsIn(["member", "source", "model"])
  dimension: "member" | "source" | "model" = "member"

  @ApiPropertyOptional({ example: "2026-08-01T00:00:00.000Z", description: "起始时间（含，ISO）" })
  @IsOptional()
  @IsDateString()
  startDate?: string

  @ApiPropertyOptional({ example: "2026-08-31T23:59:59.999Z", description: "结束时间（含，ISO）" })
  @IsOptional()
  @IsDateString()
  endDate?: string
}
