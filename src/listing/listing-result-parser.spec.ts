import { parseListingJsonObject } from "./listing-result-parser"

describe("主生成扣费前的原始正文守卫", () => {
  it("只修复已闭合正文的格式，不补写产品信息", () => {
    expect(
      parseListingJsonObject('说明\n```json\n{"title":"Earbuds", "bullets":["Portable",],}\n```')
    ).toEqual({ title: "Earbuds", bullets: ["Portable"] })
  })
  it.each([
    '{"title":"Earbuds", "details":{"color":"Black"}',
    '{"title":"unfinished',
    "没有结构化内容",
  ])("拒绝不完整正文 %s", text => {
    expect(() => parseListingJsonObject(text)).toThrow()
  })
  it("字符串中的括号不是容器结束标记", () => {
    expect(parseListingJsonObject('{"title":"Earbuds } [", "description":"Good"}').title).toBe(
      "Earbuds } ["
    )
  })
})
