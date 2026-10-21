import { ApiProperty } from "@nestjs/swagger"
import { ArrayMinSize, IsArray, IsInt } from "class-validator"

export class ReorderMenuDto {
  @ApiProperty({
    type: [Number],
    example: [12, 8, 15],
    description:
      "同一同级分组（同 parentKey）拖拽后的新顺序 id 列表；后端按下标重写 sortOrder=下标+1，前端不传数字",
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  orderedIds!: number[]
}
