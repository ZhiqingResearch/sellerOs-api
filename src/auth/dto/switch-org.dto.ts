import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsInt, IsOptional } from "class-validator"

export class SwitchOrgDto {
  @ApiPropertyOptional({
    example: 1,
    nullable: true,
    description: "目标组织 id；传 null 或不传表示清空当前组织",
  })
  @IsOptional()
  @IsInt()
  orgId?: number | null
}
