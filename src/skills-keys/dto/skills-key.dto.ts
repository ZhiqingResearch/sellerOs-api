import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import { IsString, IsUUID, Matches, MaxLength, ValidateIf } from "class-validator"

export class SkillsKeyProjectDto {
  @ApiProperty({ example: "selleros", description: "后端登记的接入项目代码" })
  @IsString({ message: "projectCode 必须为字符串" })
  @Matches(/^[a-z][a-z0-9_-]*$(?![\s\S])/, { message: "projectCode 格式不正确" })
  @MaxLength(50, { message: "projectCode 最长 50 个字符" })
  projectCode: string
}

export class SkillsKeyOperationDto extends SkillsKeyProjectDto {
  @ApiProperty({
    example: "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c",
    description: "本次操作 UUID；网络重试必须复用，不可跨生成/重置操作复用",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.toLowerCase() : value
  )
  @IsUUID("all", { message: "operationId 必须为 UUID" })
  operationId: string
}

export class SkillsKeyQueryDto {
  @ApiPropertyOptional({ example: "selleros", description: "省略时查询默认接入项目" })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString({ message: "projectCode 必须为字符串" })
  @Matches(/^[a-z][a-z0-9_-]*$(?![\s\S])/, { message: "projectCode 格式不正确" })
  @MaxLength(50, { message: "projectCode 最长 50 个字符" })
  projectCode?: string
}
