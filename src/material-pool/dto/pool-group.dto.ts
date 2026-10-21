import { ApiProperty } from "@nestjs/swagger"
import { IsNotEmpty, IsString, MaxLength } from "class-validator"

export class CreatePoolGroupDto {
  @ApiProperty({ description: "分组名", example: "夏季新品" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string
}

export class RenamePoolGroupDto {
  @ApiProperty({ description: "新分组名", example: "夏季主推" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string
}
