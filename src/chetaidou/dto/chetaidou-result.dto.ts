import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"

export class InpaintBoxDto {
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) n: number
  @ApiProperty({ example: 0.1 }) @IsNumber() @Min(0) @Max(1) x: number
  @ApiProperty({ example: 0.1 }) @IsNumber() @Min(0) @Max(1) y: number
  @ApiProperty({ example: 0.3 }) @IsNumber() @Min(Number.EPSILON) @Max(1) w: number
  @ApiProperty({ example: 0.3 }) @IsNumber() @Min(Number.EPSILON) @Max(1) h: number
  @ApiProperty({ example: "换成浅灰色墙面" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  instruction: string
  @ApiPropertyOptional({ type: [Number], example: [] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  refImageNumbers?: number[]
}

export class InpaintResultDto {
  @ApiProperty() @IsUUID() idempotencyKey: string
  @ApiProperty({ example: 1536 }) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) sourceWidth: number
  @ApiProperty({ example: 2048 })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sourceHeight: number
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) prompt?: string
  @ApiPropertyOptional({ example: "ZQ-Image-2" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  imageModel?: string
  @ApiProperty({ type: [InpaintBoxDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InpaintBoxDto)
  annotatedBoxes: InpaintBoxDto[]
}

export class SaveResultTemplateDto {
  @ApiProperty() @IsUUID() idempotencyKey: string
  @ApiProperty({ enum: ["CREATE", "APPEND"] }) @IsIn(["CREATE", "APPEND"]) mode: "CREATE" | "APPEND"
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) templateId?: number
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) groupName?: string
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string
}

export class SaveResultMaterialDto {
  @ApiProperty() @IsUUID() idempotencyKey: string
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) name: string
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) groupId?: number
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]
}
