import { plainToInstance } from "class-transformer"
import { validateSync } from "class-validator"
import { CreateAiSplitTaskDto } from "./ai-split.dto"

describe("CreateAiSplitTaskDto — site 动态格式校验", () => {
  function siteErrors(site: unknown): string[] {
    const dto = plainToInstance(CreateAiSplitTaskDto, { site })
    return validateSync(dto)
      .filter(error => error.property === "site")
      .flatMap(error => Object.values(error.constraints ?? {}))
  }

  it("接受 平台_国家码 格式（旧枚举站点与新平台站点同口径放行）", () => {
    expect(siteErrors("AMAZON_US")).toEqual([])
    expect(siteErrors("TIKTOK_MX")).toEqual([])
    expect(siteErrors("temu_br")).toEqual([])
    // 大小写与连字符分隔也放行（解析层统一归一）
    expect(siteErrors("amazon-de")).toEqual([])
  })

  it("拒绝非站点码格式", () => {
    expect(siteErrors("AMAZON")).not.toEqual([])
    expect(siteErrors("amazon_usa")).not.toEqual([])
    expect(siteErrors("US")).not.toEqual([])
    expect(siteErrors("")).not.toEqual([])
  })

  it("错误文案给出格式提示", () => {
    const errors = siteErrors("amazon")
    expect(errors.some(message => message.includes("站点格式不合法"))).toBe(true)
  })
})
