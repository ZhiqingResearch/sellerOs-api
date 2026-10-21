import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

export class MenuNodeDto {
  @ApiProperty({ example: 12 })
  id!: number

  @ApiProperty({ example: "tool.custom_report", description: "权限标识 key" })
  key!: string

  @ApiProperty({ example: "自定义报表", description: "菜单名称" })
  label!: string

  @ApiProperty({ example: "tools", description: "分组" })
  groupCode!: string

  @ApiPropertyOptional({ example: "tool.parent", nullable: true, description: "父菜单 key" })
  parentKey!: string | null

  @ApiPropertyOptional({ example: "/custom-report", nullable: true, description: "页面路径" })
  route!: string | null

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    example: ["/custom-report/[id]"],
    description: "可访问路由白名单",
  })
  subRoutes!: string[] | null

  @ApiProperty({ example: 1, description: "同级排序（小者靠前）" })
  sortOrder!: number

  @ApiProperty({ type: [MenuNodeDto], description: "子菜单" })
  children!: MenuNodeDto[]
}

export class MenuGroupDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "tools", description: "分组编码，创建后不可修改" })
  code!: string

  @ApiProperty({ example: "工具", description: "分组名" })
  label!: string

  @ApiProperty({ example: false, description: "是否内置分组（内置不可删除）" })
  isBuiltin!: boolean

  @ApiProperty({ example: 1, description: "排序值（小者靠前）" })
  sortOrder!: number

  @ApiProperty({ example: 12, description: "组内菜单数量（含子菜单）" })
  menuCount!: number
}

export class MenuTreeGroupDto {
  @ApiProperty({ example: "tools", description: "分组编码" })
  code!: string

  @ApiProperty({ example: "工具", description: "分组名" })
  label!: string

  @ApiProperty({ example: 1, description: "分组排序值（小者靠前）" })
  sortOrder!: number

  @ApiProperty({ example: 12, description: "组内菜单数量（含子菜单）" })
  menuCount!: number

  @ApiProperty({ type: [MenuNodeDto], description: "该分组的顶级菜单（children 内含子菜单）" })
  menus!: MenuNodeDto[]
}

export class MenuTreeResponseDto {
  @ApiProperty({ type: [MenuTreeGroupDto], description: "按分组 sortOrder 排序的分组菜单树" })
  groups!: MenuTreeGroupDto[]
}
