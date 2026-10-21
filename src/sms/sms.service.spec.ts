import { ConfigService } from "@nestjs/config"
import { PrismaService } from "../prisma/prisma.service"
import { SmsService } from "./sms.service"

const request = jest.fn()
jest.mock("@alicloud/pop-core", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ request })),
}))

describe("SmsService", () => {
  const phone = "15884033673"
  let service: SmsService
  let prisma: {
    smsCode: { findFirst: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
    $transaction: jest.Mock
  }
  let config: ConfigService
  const record = () => ({
    id: 1,
    phone,
    code: "123456",
    used: false,
    attempts: 0,
    createdAt: new Date(),
    expiredAt: new Date(Date.now() + 300000),
  })

  beforeEach(() => {
    request.mockReset().mockResolvedValue({ Code: "OK" })
    prisma = {
      smsCode: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation(operations => Promise.all(operations)),
    }
    config = new ConfigService({
      ACCESS_KEY_ID: "test-id",
      ACCESS_KEY_SECRET: "test-secret",
      SMS_TEMPLATE_CODE: "SMS_TEST",
      SMS_SIGN_NAME: "测试签名",
    })
    service = new SmsService(config, prisma as unknown as PrismaService)
  })

  it("发送6位验证码并作废旧码，模板参数名为 code", async () => {
    await service.sendCode(phone)

    expect(prisma.smsCode.updateMany).toHaveBeenCalledWith({
      where: { phone, used: false },
      data: { used: true },
    })
    const [{ data }] = prisma.smsCode.create.mock.calls[0] as [
      { data: { code: string; expiredAt: Date } },
    ]
    expect(data.code).toMatch(/^\d{6}$/)
    expect(data.expiredAt.getTime() - Date.now()).toBeGreaterThan(290000)
    expect(request).toHaveBeenCalledWith(
      "SendSms",
      {
        PhoneNumbers: phone,
        SignName: "测试签名",
        TemplateCode: "SMS_TEST",
        TemplateParam: JSON.stringify({ code: data.code }),
      },
      { method: "POST", formatParams: false }
    )
  })

  it("60秒内不能重发", async () => {
    prisma.smsCode.findFirst.mockResolvedValue(record())
    await expect(service.sendCode(phone)).rejects.toThrow("60秒")
    expect(request).not.toHaveBeenCalled()
    expect(prisma.smsCode.create).not.toHaveBeenCalled()
  })

  it("配置缺失时不落库、不发送", async () => {
    const emptyConfig = new ConfigService({})
    jest.spyOn(emptyConfig, "get").mockReturnValue(undefined)
    service = new SmsService(emptyConfig, prisma as unknown as PrismaService)
    await expect(service.sendCode(phone)).rejects.toThrow("短信服务未配置")
    expect(prisma.smsCode.create).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each(["business", "network"])("%s 发送失败时作废新码", async failure => {
    if (failure === "business") request.mockResolvedValue({ Code: "isv.INVALID_PARAMETERS" })
    else request.mockRejectedValue(new Error("network error"))

    await expect(service.sendCode(phone)).rejects.toThrow("短信发送失败")
    expect(prisma.smsCode.updateMany).toHaveBeenLastCalledWith({
      where: { id: 1 },
      data: { used: true },
    })
  })

  it.each([
    null,
    { ...record(), used: true },
    { ...record(), attempts: 5 },
    { ...record(), expiredAt: new Date(0) },
  ])("不存在、已核销、失败达限或过期的码不能使用", async value => {
    prisma.smsCode.findFirst.mockResolvedValue(value)
    expect(await service.verifyCode(phone, "123456")).toBe(false)
    expect(prisma.smsCode.updateMany).not.toHaveBeenCalled()
  })

  it("仅检查最新一条，错误验证码原子累计失败次数", async () => {
    prisma.smsCode.findFirst.mockResolvedValue(record())
    expect(await service.verifyCode(phone, "000000")).toBe(false)
    expect(prisma.smsCode.findFirst).toHaveBeenCalledWith({
      where: { phone },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
    expect(prisma.smsCode.updateMany).toHaveBeenCalledWith({
      where: { id: 1, used: false, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    })
  })

  it("同码并发核销仅一次成功", async () => {
    prisma.smsCode.findFirst.mockResolvedValue(record())
    prisma.smsCode.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    expect(
      await Promise.all([service.verifyCode(phone, "123456"), service.verifyCode(phone, "123456")])
    ).toEqual([true, false])
    expect(prisma.smsCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: 1,
        used: false,
        attempts: { lt: 5 },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expiredAt: { gt: expect.any(Date) },
      },
      data: { used: true },
    })
  })
})
