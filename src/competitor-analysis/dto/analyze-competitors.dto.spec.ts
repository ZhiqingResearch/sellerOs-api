import { validate } from "class-validator"
import { AnalyzeCompetitorsDto } from "./analyze-competitors.dto"

function createDto(model?: string): AnalyzeCompetitorsDto {
  return Object.assign(new AnalyzeCompetitorsDto(), {
    asins: ["B000000001"],
    country: "US",
    ...(model ? { model } : {}),
  })
}

describe("AnalyzeCompetitorsDto", () => {
  it.each(["ZQ-Think-Flash", "ZQ-Think-Lite", "ZQ-Think-Pro"])(
    "允许竞品分析模型 %s",
    async model => {
      await expect(validate(createDto(model))).resolves.toHaveLength(0)
    }
  )

  it("拒绝白名单外的模型", async () => {
    const errors = await validate(createDto("ZQ-Think-Ultra"))

    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "model" })])
    )
  })
})
