import { ConfigService } from "@nestjs/config"
import { generateKeyPairSync, sign, verify } from "node:crypto"
import { AllinpayProvider, allinpaySignContent } from "./allinpay.provider"

const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 })
const gateway = generateKeyPairSync("rsa", { modulusLength: 2048 })
const config = {
  ALLINPAY_ENABLED: "true",
  ALLINPAY_CUSID: "testMerchant",
  ALLINPAY_APPID: "testApp",
  ALLINPAY_API_ORIGIN: "https://syb-test.allinpay.com",
  ALLINPAY_NOTIFY_URL: "https://example.com/api/billing/webhooks/allinpay",
  ALLINPAY_PAYEE: "测试公司",
  ALLINPAY_PRIVATE_KEY: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ALLINPAY_PUBLIC_KEY: gateway.publicKey.export({ type: "spki", format: "pem" }).toString(),
}
const provider = new AllinpayProvider(new ConfigService(config))
function signed(fields: Record<string, string> = {}) {
  const payload = { cusid: "testMerchant", appid: "testApp", trxstatus: "0000", ...fields }
  return {
    ...payload,
    sign: sign("RSA-SHA1", Buffer.from(allinpaySignContent(payload)), gateway.privateKey).toString(
      "base64"
    ),
  }
}

afterEach(() => jest.restoreAllMocks())

it("排序时保留中文、加号及新增字段，排除 sign 和空串", () => {
  expect(allinpaySignContent({ z: "", b: "中文+&", a: "0", sign: "x" })).toBe("a=0&b=中文+&")
  const payload = signed({ futureField: "中文+&", trxamt: "1000" })
  expect(provider.verifyFields(payload)).toEqual(payload)
  expect(() => provider.verifyFields({ ...payload, trxamt: "1001" })).toThrow("签名")
})

it("拒绝其他商户的有效签名，以及重复字段/对象字段", () => {
  expect(() => provider.verifyFields(signed({ cusid: "other" }))).toThrow("商户")
  expect(() => provider.verifyFields({ ...signed(), trxamt: ["1", "2"] })).toThrow("字符串")
})

it("请求用商户私钥签名，响应只认通联公钥；下单发送人民币分和固定有效期", async () => {
  const fetchMock = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify(signed({ retcode: "SUCCESS", payinfo: "qr://test" })))
    )
  await provider.pay("SR1", 1234, "U01")
  const init = fetchMock.mock.calls[0][1]!
  const fields = Object.fromEntries(new URLSearchParams(init.body as string))
  expect(fields).toMatchObject({
    trxamt: "1234",
    paytype: "U01",
    reqsn: "SR1",
    validtime: "15",
    signtype: "RSA",
  })
  expect(
    verify(
      "RSA-SHA1",
      Buffer.from(allinpaySignContent(fields)),
      merchant.publicKey,
      Buffer.from(fields.sign, "base64")
    )
  ).toBe(true)
})

it("通信 FAIL / 超时不伪装成支付失败终态，等待原订单查询", async () => {
  const fetchMock = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ retcode: "FAIL", retmsg: "error" })))
  await expect(provider.query("SR1")).rejects.toThrow("原订单")
  fetchMock.mockRejectedValue(new Error("timeout"))
  await expect(provider.pay("SR1", 100, "W01")).rejects.toThrow("勿重复付款")
})

it("禁用时不影响启动；启用时缺少配置立即失败", () => {
  expect(() =>
    new AllinpayProvider(new ConfigService({ ALLINPAY_ENABLED: "false" })).onModuleInit()
  ).not.toThrow()
  expect(() =>
    new AllinpayProvider(new ConfigService({ ALLINPAY_ENABLED: "true" })).onModuleInit()
  ).toThrow("CUSID")
  expect(() => provider.onModuleInit()).not.toThrow()
})

it("停止新支付后仍允许存量查单", async () => {
  const disabled = new AllinpayProvider(new ConfigService({ ...config, ALLINPAY_ENABLED: "false" }))
  expect(() => disabled.pay("SR1", 100, "W01")).toThrow("暂未开放")
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(signed({ retcode: "SUCCESS" }))))
  await expect(disabled.query("SR1")).resolves.toMatchObject({ trxstatus: "0000" })
})
