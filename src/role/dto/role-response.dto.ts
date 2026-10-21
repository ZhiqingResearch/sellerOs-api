import { ApiProperty } from "@nestjs/swagger"

export class RoleItemDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "ADMIN" })
  code!: string

  @ApiProperty({ example: "管理员" })
  name!: string

  @ApiProperty({ example: "系统管理员", nullable: true })
  description!: string | null

  @ApiProperty({ example: "#ff3b30", nullable: true })
  color!: string | null

  @ApiProperty({ example: true, description: "是否内置角色（内置不可删除）" })
  isSystem!: boolean

  @ApiProperty({ example: 3, description: "该角色下用户数" })
  usersCount!: number

  @ApiProperty({ type: [String], example: ["tool.listing_generate"], description: "权限 key 列表" })
  permissionKeys!: string[]
}

export class RoleUserItemDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "张明" })
  username!: string

  @ApiProperty({ example: "13800001234" })
  phone!: string

  @ApiProperty({ example: true })
  isActive!: boolean

  @ApiProperty({ example: "2026-04-17T09:32:00.000Z", nullable: true })
  lastLoginAt!: string | null
}
