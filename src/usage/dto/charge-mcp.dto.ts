import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from "class-validator"

export class ChargeMcpDto {
  @ApiProperty({ example: 10, description: "MCP 调用次数" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  calls: number

  @ApiPropertyOptional({ example: "mcp.context7", description: "来源标识" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string

  @ApiPropertyOptional({ example: { tool: "search-docs" }, description: "额外元数据" })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>

  @ApiPropertyOptional({
    example: { query: "battery spec", docId: "ctx7-123" },
    description: "本次请求的参数快照（便于日志排查具体请求了哪些参数）",
  })
  @IsOptional()
  @IsObject()
  requestParams?: Record<string, unknown>
}
