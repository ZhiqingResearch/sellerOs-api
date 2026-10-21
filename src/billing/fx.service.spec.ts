import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { StripeProvider } from "../common/providers/stripe.provider"
import { FxService } from "./fx.service"

/** 汇率：Stripe FX Quotes（preview）CNY→USD base_rate 取倒数 + 10 分钟内存缓存 + stale 兜底；元→美分折算。 */
describe("FxService", () => {
  let service: FxService
  let getCnyUsdBaseRate: jest.Mock

  beforeEach(async () => {
    getCnyUsdBaseRate = jest.fn()
    const moduleRef = await Test.createTestingModule({
      providers: [FxService, { provide: StripeProvider, useValue: { getCnyUsdBaseRate } }],
    }).compile()
    service = moduleRef.get(FxService)
  })

  it("正常取汇率：base_rate(1 CNY=X USD) 取倒数 → 1 USD = X CNY", async () => {
    getCnyUsdBaseRate.mockResolvedValue(0.14) // 1/0.14 = 7.142857…
    const rate = await service.getUsdCnyRate()
    expect(rate.toDecimalPlaces(4).toString()).toBe("7.1429")
    expect(getCnyUsdBaseRate).toHaveBeenCalledTimes(1)
  })

  it("缓存命中（10 分钟内）不再请求", async () => {
    getCnyUsdBaseRate.mockResolvedValue(0.14)
    await service.getUsdCnyRate()
    const again = await service.getUsdCnyRate()
    expect(again.toDecimalPlaces(4).toString()).toBe("7.1429")
    expect(getCnyUsdBaseRate).toHaveBeenCalledTimes(1)
  })

  it("拉取失败走 stale 旧缓存", async () => {
    getCnyUsdBaseRate.mockResolvedValueOnce(0.14)
    await service.getUsdCnyRate()
    // 把缓存时间改到 11 分钟前（过期）后模拟拉取失败
    ;(service as unknown as { cache: { at: number } }).cache.at = Date.now() - 11 * 60 * 1000
    getCnyUsdBaseRate.mockRejectedValueOnce(new Error("network down"))
    const rate = await service.getUsdCnyRate()
    expect(rate.toDecimalPlaces(4).toString()).toBe("7.1429")
  })

  it("从未成功过 → ServiceUnavailable", async () => {
    getCnyUsdBaseRate.mockRejectedValue(new Error("network down"))
    await expect(service.getUsdCnyRate()).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(service.getUsdCnyRate()).rejects.toThrow("汇率服务暂不可用")
  })

  it("底层已是 503（如支付服务未配置）→ 原样透传不包装", async () => {
    getCnyUsdBaseRate.mockRejectedValue(new ServiceUnavailableException("支付服务未配置"))
    await expect(service.getUsdCnyRate()).rejects.toThrow("支付服务未配置")
  })

  it("cnyToUsdCents：四舍五入（HALF_UP）", () => {
    // 100 元 ÷ 7.2 = 1388.88… → 1389
    expect(service.cnyToUsdCents(new Decimal("100"), new Decimal("7.2"))).toBe(1389)
    // 199 元 ÷ 7.25 = 2744.82… → 2745
    expect(service.cnyToUsdCents(new Decimal("199"), new Decimal("7.25"))).toBe(2745)
  })

  it("cnyToUsdCents：折算低于 50 美分 → 400", () => {
    // 3 元 ÷ 7.2 ≈ 41.67 → 42 < 50
    expect(() => service.cnyToUsdCents(new Decimal("3"), new Decimal("7.2"))).toThrow(
      BadRequestException
    )
    expect(() => service.cnyToUsdCents(new Decimal("3"), new Decimal("7.2"))).toThrow(
      "折算美元金额低于支付渠道最低限额"
    )
  })
})
