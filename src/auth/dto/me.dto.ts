import { ApiProperty } from "@nestjs/swagger"

export class MeUserDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "test4" })
  username!: string

  @ApiProperty({ example: "18666190380" })
  phone!: string

  @ApiProperty({
    example: "foo@bar.com",
    nullable: true,
    description: "注册邮箱（仅邮箱注册用户有值）",
  })
  email!: string | null

  @ApiProperty({
    example: "EMAIL",
    enum: ["EMAIL", "PHONE"],
    description: "注册通道：EMAIL=邮箱注册，PHONE=手机号注册",
  })
  registerType!: "EMAIL" | "PHONE"

  @ApiProperty({ example: false, description: "模型是否已解锁" })
  modelUnlocked!: boolean

  @ApiProperty({ example: false, description: "是否需强制修改密码（重置/默认密码创建后为 true）" })
  mustChangePassword!: boolean

  @ApiProperty({ example: "2026-04-20T06:12:00.000Z" })
  createdAt!: string
}

export class MeRoleDto {
  @ApiProperty({ example: "ADMIN" })
  code!: string

  @ApiProperty({ example: "管理员" })
  name!: string

  @ApiProperty({ example: "#ff3b30", nullable: true, description: "角色标识色" })
  color!: string | null
}

export class MeOrgDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "深圳总部" })
  name!: string
}

export class MePermissionDto {
  @ApiProperty({ example: "tool.listing_generate" })
  key!: string

  @ApiProperty({ example: "Listing 生成" })
  label!: string

  @ApiProperty({ example: "tools" })
  groupCode!: string

  @ApiProperty({ example: null, nullable: true })
  parentKey!: string | null

  @ApiProperty({ example: "/listing", nullable: true })
  route!: string | null

  @ApiProperty({ example: ["/customers/[id]"], nullable: true, type: [String] })
  subRoutes!: string[] | null

  @ApiProperty({ example: 1 })
  sortOrder!: number
}

export class MePermissionGroupDto {
  @ApiProperty({ example: "tools" })
  code!: string

  @ApiProperty({ example: "工具" })
  label!: string

  @ApiProperty({ example: 1 })
  sortOrder!: number
}

export class PermissionsResponseDto {
  @ApiProperty({
    type: [MePermissionDto],
    description: "所有角色权限并集（按 sortOrder 升序去重）",
  })
  permissions!: MePermissionDto[]

  @ApiProperty({
    type: [MePermissionGroupDto],
    description: "用户权限涉及的菜单分组（按 sortOrder 升序，不含无权限的分组）",
  })
  groups!: MePermissionGroupDto[]
}

export class MeResponseDto {
  @ApiProperty({ type: MeUserDto })
  user!: MeUserDto

  @ApiProperty({ type: [MeRoleDto], description: "用户名下所有角色（多角色）" })
  roles!: MeRoleDto[]

  @ApiProperty({ type: [MeOrgDto], description: "用户所属组织" })
  orgs!: MeOrgDto[]

  @ApiProperty({
    type: [MePermissionDto],
    description: "所有角色权限并集（按 sortOrder 升序去重）",
  })
  permissions!: MePermissionDto[]
}
