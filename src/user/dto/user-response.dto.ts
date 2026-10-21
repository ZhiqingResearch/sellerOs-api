import { ApiProperty } from "@nestjs/swagger"

export class UserRoleBriefDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "ADMIN" })
  code!: string

  @ApiProperty({ example: "管理员" })
  name!: string

  @ApiProperty({ example: "#ff3b30", nullable: true })
  color!: string | null
}

export class RoleOptionDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "运营主管" })
  name!: string

  @ApiProperty({ example: "#007aff", nullable: true })
  color!: string | null
}

export class UserOrgBriefDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "深圳总部" })
  name!: string
}

export class UserItemDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "张明" })
  username!: string

  @ApiProperty({
    example: "138****1234",
    description: "手机号（默认脱敏；全号走 GET /users/:id/phone）",
  })
  phone!: string

  @ApiProperty({ type: [UserRoleBriefDto] })
  roles!: UserRoleBriefDto[]

  @ApiProperty({ type: [UserOrgBriefDto] })
  orgs!: UserOrgBriefDto[]

  @ApiProperty({ example: true })
  isActive!: boolean

  @ApiProperty({ example: "2026-04-17T09:32:00.000Z", nullable: true })
  lastLoginAt!: string | null

  @ApiProperty({ example: "2025-08-12T10:24:00.000Z" })
  createdAt!: string

  @ApiProperty({ example: "LV2", description: "会员等级（NONE/LV1-3；历史 LV4/LV5 已取消）" })
  level!: string

  @ApiProperty({ example: 2, nullable: true, description: "订阅档 1/2/3（过期仍保留）" })
  subscriptionTier!: number | null

  @ApiProperty({ example: false, description: "分销代理开关（可邀请）" })
  canInvite!: boolean

  @ApiProperty({ example: true, description: "参与返利计划" })
  rebateEnabled!: boolean

  @ApiProperty({ example: "0.3", description: "一级返佣比例（字符串十进制，如 0.3 = 30%）" })
  rebateRate!: string

  @ApiProperty({ example: 12, description: "一级下级数（其直接邀请的用户数）" })
  invitedCount!: number

  @ApiProperty({
    example: { id: 9, username: "王老板" },
    nullable: true,
    description: "邀请人（邀请返佣关系）",
  })
  invitedBy!: { id: number; username: string } | null

  @ApiProperty({
    example: { id: 3, name: "Acme", source: "SELF", role: "ADMIN", memberStatus: "ACTIVE" },
    nullable: true,
    description:
      "企业归属（占用中团队；source=SELF 团队版 / CUSTOM 平台定制；role=该用户在团队内角色；memberStatus=ACTIVE/DISABLED，DISABLED 为已停用成员）",
  })
  team!: {
    id: number
    name: string | null
    source: string
    role: string
    memberStatus: string
  } | null

  @ApiProperty({ example: "1250", description: "剩余积分（个人可消费：充值+套餐+赠送）" })
  points!: string
}

export class UserListDto {
  @ApiProperty({ type: [UserItemDto] })
  items!: UserItemDto[]

  @ApiProperty({ example: 42 })
  total!: number

  @ApiProperty({ example: 1 })
  page!: number

  @ApiProperty({ example: 10 })
  pageSize!: number

  @ApiProperty({ example: 5 })
  totalPages!: number
}
