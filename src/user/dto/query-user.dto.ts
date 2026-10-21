import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsIn, IsInt, IsOptional, IsString } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryUserDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按用户名 / 手机号模糊搜索" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({ description: "按组织 id 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  orgId?: number

  @ApiPropertyOptional({
    enum: ["NONE", "LV1", "LV2", "LV3", "TEAM", "CUSTOM_TEAM"],
    description:
      "等级筛选：NONE/LV1-3=订阅档；TEAM=团队版（自助）成员；CUSTOM_TEAM=平台定制企业成员",
  })
  @IsOptional()
  @IsIn(["NONE", "LV1", "LV2", "LV3", "TEAM", "CUSTOM_TEAM"])
  level?: "NONE" | "LV1" | "LV2" | "LV3" | "TEAM" | "CUSTOM_TEAM"

  @ApiPropertyOptional({
    enum: ["true", "false"],
    description: "邀请状态：true=被邀请人 / false=非被邀请人",
  })
  @IsOptional()
  @IsIn(["true", "false"])
  invited?: "true" | "false"

  @ApiPropertyOptional({ description: "企业归属筛选（团队 id，命中 ACTIVE 成员）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teamId?: number

  @ApiPropertyOptional({
    enum: ["true", "false"],
    description:
      "企业归属（布尔口径）：true=有占用中企业（ACTIVE/DISABLED 成员 + ACTIVE/GRACE 团队）；false=纯个人计费",
  })
  @IsOptional()
  @IsIn(["true", "false"])
  hasTeam?: "true" | "false"

  @ApiPropertyOptional({
    enum: ["true", "false"],
    description: "分销代理开关：true=可邀请（计酬）；false=未开启",
  })
  @IsOptional()
  @IsIn(["true", "false"])
  canInvite?: "true" | "false"
}
