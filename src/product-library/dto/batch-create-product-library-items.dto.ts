import { ApiProperty } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from "class-validator"
import { CreateProductLibraryItemDto } from "./create-product-library-item.dto"

export class BatchCreateProductLibraryItemsDto {
  @ApiProperty({ type: [CreateProductLibraryItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateProductLibraryItemDto)
  items: CreateProductLibraryItemDto[]
}
