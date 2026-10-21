import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsOptional, IsString, MaxLength } from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"
import { UpsertBrandIdentityDto } from "./image-project.dto"

// 保存到品牌库：字段镜像品牌基因（UpsertBrandIdentityDto），允许同名，不做查重。
export class SaveBrandKitDto extends UpsertBrandIdentityDto {}

export class QueryBrandKitDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按品牌中/英文名模糊搜索" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string
}
