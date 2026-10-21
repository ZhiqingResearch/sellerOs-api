import { ApiProperty } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsPositive } from "class-validator"

export class BulkDeleteSensitiveWordDto {
  @ApiProperty({
    example: [1, 2, 3],
    description: "要删除的敏感词 id 列表，1-1000 个，全部为正整数",
    type: [Number],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  @Type(() => Number)
  ids!: number[]
}
