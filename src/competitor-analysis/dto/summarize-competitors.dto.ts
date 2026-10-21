import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsObject, IsOptional } from "class-validator"
import { AnalyzeCompetitorsDto } from "./analyze-competitors.dto"

export class SummarizeCompetitorsDto extends AnalyzeCompetitorsDto {
  @ApiProperty({
    description: "三个独立模块接口返回的原始响应",
    example: { profile: {}, traffic: {}, pricePromo: {} },
  })
  @IsObject()
  modules!: Record<string, unknown>

  @ApiPropertyOptional({
    description: "完整事实数据快照，仅用于后端归档，不重复送入模型",
    example: { profiles: [], boards: [], priceBoards: [] },
  })
  @IsOptional()
  @IsObject()
  recordSnapshot?: Record<string, unknown>
}
