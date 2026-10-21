import { ApiProperty } from "@nestjs/swagger"
import { IsString, Matches, MaxLength, MinLength } from "class-validator"

/** 分组编码命名规范：小写字母开头，仅小写字母/数字/下划线 */
export const GROUP_CODE_PATTERN = /^[a-z][a-z0-9_]*$/

export class CreateMenuGroupDto {
  @ApiProperty({
    example: "reports",
    description: "分组编码，全局唯一，创建后不可修改",
  })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(GROUP_CODE_PATTERN, {
    message: "code 仅允许小写字母开头的字母/数字/下划线",
  })
  code!: string

  @ApiProperty({ example: "报表", description: "分组名（前端展示）" })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string
}
