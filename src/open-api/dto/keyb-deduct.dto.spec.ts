import { plainToInstance } from "class-transformer"
import { validateSync } from "class-validator"
import { KeybDeductDto } from "./keyb-deduct.dto"

const payload = {
  costCny: "0.000001",
  source: "listing.generate",
  model: "test-model",
  requestId: "task-123",
}

describe("KeybDeductDto", () => {
  it.each(["0.000001", "0.35", "1.000000", "999999.999999"])("接受十进制字符串%s", costCny => {
    expect(validateSync(plainToInstance(KeybDeductDto, { ...payload, costCny }))).toEqual([])
  })

  it.each([
    0.35,
    1,
    0,
    "0",
    "-1",
    "Infinity",
    "NaN",
    "1e-6",
    "0.0000001",
    "1000000",
    "1\n",
    "1\r",
    "1\r\n",
    null,
    true,
  ])("拒绝非字符串、非正数、不安全精度或超范围金额%j", costCny => {
    expect(validateSync(plainToInstance(KeybDeductDto, { ...payload, costCny }))).not.toEqual([])
  })

  it("限制字段长度并强制requestId", () => {
    expect(
      validateSync(plainToInstance(KeybDeductDto, { ...payload, requestId: "x".repeat(128) }))
    ).toEqual([])
    for (const overrides of [
      { requestId: undefined },
      { requestId: "x".repeat(129) },
      { source: "x".repeat(51) },
      { model: "x".repeat(101) },
      { meta: [] },
    ]) {
      expect(
        validateSync(plainToInstance(KeybDeductDto, { ...payload, ...overrides }))
      ).not.toEqual([])
    }
  })
})
