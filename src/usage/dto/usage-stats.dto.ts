import { ApiProperty } from "@nestjs/swagger"
import { MePermissionDto, MeRoleDto } from "../../auth/dto/me.dto"

export class UsageStatsByUserItemDto {
  @ApiProperty({ example: 1 })
  userId!: number

  @ApiProperty({ example: "test4" })
  username!: string

  @ApiProperty({ example: "18666190380" })
  phone!: string

  @ApiProperty({ example: "LV2", description: "会员等级（NONE/LV1/LV2/LV3/FOUNDER/INVITER）" })
  level!: string

  @ApiProperty({
    example: "8310",
    description: "总积分（= remaining + totalConsumed，沿用「总额度=剩余+已消耗」口径）",
  })
  totalQuota!: string

  @ApiProperty({
    example: "7076",
    description: "剩余积分（各桶 ACTIVE 可消费 remaining 之和，全局口径）",
  })
  remaining!: string

  @ApiProperty({ example: "1234", description: "所选时间段内已消耗积分（TOKEN/视频通道）" })
  totalConsumed!: string

  @ApiProperty({ example: 135000, description: "所选时间段内的总 tokens（input+output+thinking）" })
  totalTokens!: number

  @ApiProperty({ type: [MeRoleDto], description: "用户角色（多角色）" })
  roles!: MeRoleDto[]

  @ApiProperty({
    type: [MePermissionDto],
    description: "用户菜单/权限并集（按 sortOrder 升序去重）",
  })
  permissions!: MePermissionDto[]
}

export class UsageStatsSourceItemDto {
  @ApiProperty({ example: "listing_generate", description: "调用来源（模块）" })
  source!: string

  @ApiProperty({ example: "1234", description: "该 source 的已消耗积分" })
  totalConsumed!: string

  @ApiProperty({ example: 135000, description: "该 source 的总 tokens" })
  totalTokens!: number

  @ApiProperty({ example: 42, description: "该 source 的调用次数" })
  callCount!: number
}

export class UsageStatsSummaryDto {
  @ApiProperty({ example: 93, description: "用户总数" })
  userCount!: number

  @ApiProperty({
    example: "278632",
    description: "全站总额度积分（= remaining + totalCost，沿用「总额度=剩余+已消耗」口径）",
  })
  totalQuota!: string

  @ApiProperty({ example: "7662", description: "所选时间段内的总已消耗积分" })
  totalCost!: string

  @ApiProperty({ example: "270969", description: "全站剩余积分（各用户可消费 remaining 之和）" })
  remaining!: string

  @ApiProperty({ example: 273076298, description: "所选时间段内的总消耗 tokens" })
  totalTokens!: number
}
