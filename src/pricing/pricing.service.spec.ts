import { NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PricingCategory, PricingTier } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { PricingService } from "./pricing.service"

function buildConfig(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    key: "",
    name: "",
    category: PricingCategory.TOKEN_INPUT,
    tier: PricingTier.LOW,
    threshold: 200000,
    originalPriceUsd: new Decimal(0),
    markupPriceUsd: new Decimal(0),
    markupPriceCny: new Decimal(0),
    unit: "MTok",
    active: true,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("PricingService", () => {
  let service: PricingService
  let prisma: {
    pricingConfig: {
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
    }
  }

  const allConfigs = [
    buildConfig({
      key: "TOKEN_INPUT_LOW",
      category: PricingCategory.TOKEN_INPUT,
      tier: PricingTier.LOW,
      markupPriceCny: new Decimal(9),
    }),
    buildConfig({
      key: "TOKEN_INPUT_HIGH",
      category: PricingCategory.TOKEN_INPUT,
      tier: PricingTier.HIGH,
      markupPriceCny: new Decimal(18),
    }),
    buildConfig({
      key: "TOKEN_OUTPUT_LOW",
      category: PricingCategory.TOKEN_OUTPUT,
      tier: PricingTier.LOW,
      markupPriceCny: new Decimal(54),
    }),
    buildConfig({
      key: "TOKEN_OUTPUT_HIGH",
      category: PricingCategory.TOKEN_OUTPUT,
      tier: PricingTier.HIGH,
      markupPriceCny: new Decimal(81),
    }),
    buildConfig({
      key: "MCP_CALL",
      category: PricingCategory.MCP,
      tier: PricingTier.SINGLE,
      threshold: null,
      unit: "call",
      markupPriceCny: new Decimal("0.12375"),
    }),
  ]

  beforeEach(async () => {
    prisma = {
      pricingConfig: {
        findMany: jest.fn().mockResolvedValue(allConfigs),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    }

    const module = await Test.createTestingModule({
      providers: [PricingService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(PricingService)
  })

  describe("getTokenPriceTier", () => {
    it("promptTokens ≤ 20万 → LOW 档，输入 9、输出 54", async () => {
      const result = await service.getTokenPriceTier(150000)
      expect(result.tier).toBe(PricingTier.LOW)
      expect(result.inputPriceCny.toString()).toBe("9")
      expect(result.outputPriceCny.toString()).toBe("54")
    })

    it("promptTokens = 20万（阈值）→ LOW 档", async () => {
      const result = await service.getTokenPriceTier(200000)
      expect(result.tier).toBe(PricingTier.LOW)
    })

    it("promptTokens > 20万 → HIGH 档，输入 18、输出 81", async () => {
      const result = await service.getTokenPriceTier(250000)
      expect(result.tier).toBe(PricingTier.HIGH)
      expect(result.inputPriceCny.toString()).toBe("18")
      expect(result.outputPriceCny.toString()).toBe("81")
    })
  })

  describe("getMcpCallPrice", () => {
    it("返回 0.12375", async () => {
      const price = await service.getMcpCallPrice()
      expect(price.toString()).toBe("0.12375")
    })
  })

  describe("cache", () => {
    it("多次查询只加载一次 DB", async () => {
      await service.getTokenPriceTier(100)
      await service.getTokenPriceTier(100)
      await service.getMcpCallPrice()
      expect(prisma.pricingConfig.findMany).toHaveBeenCalledTimes(1)
    })

    it("update 后缓存失效，下次查询重新加载", async () => {
      await service.getTokenPriceTier(100)
      prisma.pricingConfig.findUnique.mockResolvedValue(allConfigs[0])
      prisma.pricingConfig.update.mockResolvedValue(allConfigs[0])
      await service.update("TOKEN_INPUT_LOW", { markupPriceCny: 10 })
      await service.getTokenPriceTier(100)
      expect(prisma.pricingConfig.findMany).toHaveBeenCalledTimes(2)
    })

    it("refresh 清空缓存", async () => {
      await service.getTokenPriceTier(100)
      service.refresh()
      await service.getTokenPriceTier(100)
      expect(prisma.pricingConfig.findMany).toHaveBeenCalledTimes(2)
    })
  })

  describe("update", () => {
    it("key 不存在抛 NotFoundException", async () => {
      prisma.pricingConfig.findUnique.mockResolvedValue(null)
      await expect(service.update("UNKNOWN", {})).rejects.toThrow(NotFoundException)
    })
  })

  describe("listAll", () => {
    it("返回所有定价配置", async () => {
      const list = await service.listAll()
      expect(list).toHaveLength(5)
    })
  })
})
