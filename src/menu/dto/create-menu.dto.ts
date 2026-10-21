import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator"

/** 分组编码命名规范：小写字母开头，仅小写字母/数字/下划线（存在性由 PermissionGroup 表校验） */
export const MENU_GROUP_CODE_PATTERN = /^[a-z][a-z0-9_]*$/

/** 权限标识 key 命名规范：小写字母/数字/下划线，以点分层，如 tool.custom_report */
export const MENU_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/

export class CreateMenuDto {
  @ApiProperty({
    example: "tool.custom_report",
    description: "权限标识 key（全局唯一，形如 tool.xxx / management.xxx.yyy）",
  })
  @IsString()
  @MaxLength(100)
  @Matches(MENU_KEY_PATTERN, {
    message: "key 仅允许小写字母/数字/下划线，以点分层，如 tool.custom_report",
  })
  key!: string

  @ApiProperty({ example: "自定义报表", description: "菜单名称" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string

  @ApiPropertyOptional({
    example: "tools",
    description: "分组编码（顶级菜单必填，须为已存在的分组；子菜单忽略此值，自动继承父菜单分组）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(MENU_GROUP_CODE_PATTERN, {
    message: "groupCode 仅允许小写字母开头的字母/数字/下划线",
  })
  groupCode?: string

  @ApiPropertyOptional({ example: "/custom-report", description: "页面路径" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string

  @ApiPropertyOptional({
    example: "tool.custom_report",
    description: "父菜单 key（传则为子菜单；不传为顶级菜单）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  parentKey?: string

  @ApiPropertyOptional({
    type: [String],
    example: ["/custom-report/[id]"],
    description: "可访问路由白名单（与子菜单无关，仅放行前端可访问的额外路由）",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subRoutes?: string[]
}
