import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

/** 「下级进企业后仍计返利」逐人开关项（InviteConfigDto.corpPassUpToggles） */
export class CorpPassUpToggleItemDto {
  @ApiProperty({ example: 21, description: "下级用户 id（须为直接下级 + 占用中企业管理员）" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number

  @ApiProperty({ example: true, description: "该企业共享池消耗是否仍返利给本邀请人" })
  @IsBoolean()
  enabled: boolean
}

/** 后台设置某用户的邀请配置（开/关邀请、折扣、返利比例、名额/二级返利/参与返利开关） */
export class InviteConfigDto {
  @ApiPropertyOptional({
    example: true,
    description: "是否允许邀请（邀请只是关系不是等级；不影响其套餐/积分）",
  })
  @IsOptional()
  @IsBoolean()
  canInvite?: boolean

  @ApiPropertyOptional({
    example: 0.8,
    description: "平台使用折扣（0.5~1.0，本人及被邀请人消费打折）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(1)
  discount?: number

  @ApiPropertyOptional({
    example: 0.3,
    description: "返利比例（0~0.5，被邀请人消费按此返给邀请人）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.5)
  rebateRate?: number

  @ApiPropertyOptional({
    example: false,
    description:
      "邀请的用户共享我的额度：开启后其下级在自身额度外可继续消耗该邀请人额度（默认关闭）",
  })
  @IsOptional()
  @IsBoolean()
  shareCredits?: boolean

  @ApiPropertyOptional({
    example: 50,
    description: "邀请名额（实际建号计1，含手机号自助注册）；传 null 表示不限",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: InviteConfigDto) => o.inviteQuota !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  inviteQuota?: number | null

  @ApiPropertyOptional({ example: true, description: "下级（被邀请人）可继续邀请" })
  @IsOptional()
  @IsBoolean()
  subInviteAllowed?: boolean

  @ApiPropertyOptional({ example: true, description: "参与返利计划（关闭后其上级的返利跳过该层）" })
  @IsOptional()
  @IsBoolean()
  rebateEnabled?: boolean

  @ApiPropertyOptional({
    example: 0.1,
    description: "二级返利比例（0~0.5）；传 null 用全局默认 0.10",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: InviteConfigDto) => o.level2RebateRate !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.5)
  level2RebateRate?: number | null

  @ApiPropertyOptional({
    type: [CorpPassUpToggleItemDto],
    description:
      "「下级进企业后仍计返利」逐人开关（2026-08-31）：每个 userId 必须是本邀请人的直接下级且当前为占用中企业管理员；" +
      "写其 corpPassUp（逐人设定优先于全局 corpCounts）",
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CorpPassUpToggleItemDto)
  corpPassUpToggles?: CorpPassUpToggleItemDto[]
}

/** 我邀请的用户列表查询：分页 + 搜索（用户名/手机号）+ 角色筛选 + 排序 */
export class QueryInviteesDto extends PaginationDto {
  @ApiPropertyOptional({ example: "张", description: "搜索：用户名 / 手机号（模糊）" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({ example: "operator", description: "按角色 code 筛选" })
  @IsOptional()
  @IsString()
  role?: string

  @ApiPropertyOptional({
    example: "2026-08-01",
    description: "注册时间起（YYYY-MM-DD，含当天，按北京自然日 00:00:00 起算）",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "startDate 格式应为 YYYY-MM-DD" })
  startDate?: string

  @ApiPropertyOptional({
    example: "2026-08-31",
    description: "注册时间止（YYYY-MM-DD，含当天，按北京自然日 23:59:59.999 止）",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "endDate 格式应为 YYYY-MM-DD" })
  endDate?: string

  @ApiPropertyOptional({
    enum: ["consumed", "remaining", "total", "createdAt"],
    example: "consumed",
    description: "排序字段，默认 consumed（已消耗）",
  })
  @IsOptional()
  @IsIn(["consumed", "remaining", "total", "createdAt"])
  sortBy?: "consumed" | "remaining" | "total" | "createdAt"

  @ApiPropertyOptional({
    enum: ["asc", "desc"],
    example: "desc",
    description: "排序方向，默认 desc",
  })
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortDir?: "asc" | "desc"
}

/** 邀请人停用 / 启用其下级账号 */
export class UpdateInviteeStatusDto {
  @ApiProperty({ example: false, description: "true=启用，false=停用" })
  @IsBoolean()
  isActive: boolean
}

/** 发送邮箱注册验证码 */
export class SendEmailCodeDto {
  @ApiProperty({ example: "buyer@example.com" })
  @IsEmail()
  email: string
}

/** 邀请注册：邀请码 + 用户名(称谓) + 邮箱 + 手机 + 邮箱验证码 + 密码 */
export class InviteRegisterDto {
  @ApiProperty({ example: "OS8K3F", description: "邀请码（链接自动填充）" })
  @IsString()
  @Length(4, 32)
  inviteCode: string

  @ApiProperty({ example: "张三", description: "用户名 / 称谓（一般为真人姓名），必填，≤50" })
  @IsString()
  @Length(1, 50)
  username: string

  @ApiProperty({ example: "buyer@example.com" })
  @IsEmail()
  email: string

  @ApiProperty({ example: "18800000000", description: "手机号" })
  @Matches(/^1[3-9]\d{9}$/, { message: "手机号格式不正确" })
  phone: string

  @ApiProperty({ example: "123456", description: "邮箱验证码（6 位）" })
  @IsString()
  @Length(6, 6)
  emailCode: string

  @ApiProperty({ example: "Passw0rd!", description: "密码（≥6 位）" })
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password: string
}

/** 返利提现 */
export class RebateWithdrawDto {
  @ApiProperty({
    example: 500,
    description: "提现积分（>0，支持 4 位小数——返利不抹零后余额可能带小数）",
  })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount: number

  @ApiPropertyOptional({ example: "提现至支付宝", description: "提现说明（留档）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string
}
