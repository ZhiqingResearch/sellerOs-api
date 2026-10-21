import { ApiProperty } from "@nestjs/swagger"
import { IsUrl, MaxLength } from "class-validator"

export class UpdateCompetitorAnalysisReportPdfDto {
  @ApiProperty({
    example: "https://cdn.example.com/competitor-analysis/user/record/report.pdf",
  })
  @IsUrl({ protocols: ["https"], require_protocol: true, require_valid_protocol: true })
  @MaxLength(2048)
  reportPdfUrl: string
}
