import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator"
import { MENU_GROUP_CODE_PATTERN, MENU_KEY_PATTERN } from "./create-menu.dto"

export class UpdateMenuDto {
  @ApiPropertyOptional({ example: "自定义报表", description: "菜单名称" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string

  @ApiPropertyOptional({ example: "/custom-report", description: "页面路径（传空字符串可清空）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string

  @ApiPropertyOptional({
    example: "tool.custom_report",
    description: "权限标识 key（改后需保持唯一）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(MENU_KEY_PATTERN, {
    message: "key 仅允许小写字母/数字/下划线，以点分层，如 tool.custom_report",
  })
  key?: string

  @ApiPropertyOptional({
    example: "tools",
    description: "分组编码（仅顶级菜单可改，须为已存在的分组，会级联同步整棵子树；子菜单分组继承父级，不可单独改）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(MENU_GROUP_CODE_PATTERN, {
    message: "groupCode 仅允许小写字母开头的字母/数字/下划线",
  })
  groupCode?: string

  @ApiPropertyOptional({
    type: [String],
    example: ["/custom-report/[id]"],
    description: "可访问路由白名单。传数组整体覆盖；传 null 清空；不传保持原值",
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subRoutes?: string[] | null
}
