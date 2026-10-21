import { BadRequestException, ExecutionContext } from "@nestjs/common"
import { ExternalUserPhonePipe, readExternalUserPhone } from "./external-user-phone.decorator"

describe("ExternalUserPhone", () => {
  const pipe = new ExternalUserPhonePipe()

  it("从 X-User-Phone 请求头读取手机号", () => {
    const request = { get: jest.fn().mockReturnValue("13800001234") }
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext

    expect(readExternalUserPhone(context)).toBe("13800001234")
    expect(request.get).toHaveBeenCalledWith("X-User-Phone")
  })

  it.each([undefined, null, "", "   "])("请求头缺失或为空时返回 400：%s", value => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException)
    expect(() => pipe.transform(value)).toThrow("X-User-Phone 请求头不能为空")
  })

  it("请求头超过 20 个字符时返回 400", () => {
    expect(() => pipe.transform("1".repeat(21))).toThrow(BadRequestException)
    expect(() => pipe.transform("1".repeat(21))).toThrow("X-User-Phone 长度不能超过 20 个字符")
  })

  it("校验通过后移除手机号前后空格", () => {
    expect(pipe.transform(" 13800001234 ")).toBe("13800001234")
  })
})
