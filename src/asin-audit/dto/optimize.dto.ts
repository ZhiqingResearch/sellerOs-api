import { ApiProperty } from "@nestjs/swagger"
import { IsObject } from "class-validator"
import { ScoreRequestDto } from "./score.dto"

/**
 * 优化交付物请求 = 打分请求 + 上一步评分结果（score 必填，服务层校验）。
 * 后端不信任 score 中的任何积分/身份字段（仅作模型上下文）。
 */
export class OptimizeRequestDto extends ScoreRequestDto {
  @ApiProperty({
    description: "第二步打分结果（必填；结构见 types/audit.types.ts AuditScoreResult）",
    example: {
      historyTitle: "…",
      total: 78,
      grade: "B+",
      potential: "…",
      dimensions: [],
      suggestions: [],
      problemTypes: {},
    },
  })
  @IsObject()
  score!: Record<string, unknown>
}
