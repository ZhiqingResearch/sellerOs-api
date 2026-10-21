import { ApiProperty } from "@nestjs/swagger"
import { ArrayNotEmpty, IsArray, IsString } from "class-validator"

export class CreateSelectedProductsDto {
  @ApiProperty({ example: ["P001", "P002", "P003"], description: "产品编码数组" })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  productCodes: string[]
}
