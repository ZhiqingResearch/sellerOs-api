import { BadRequestException, HttpException, Logger } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { OpenApiApp } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { SkillsKeysService } from "../skills-keys/skills-keys.service"
import { FeatureRegistryService } from "../usage/feature-registry.service"
import { ChargeModelParams, ChargeModelResult, UsageService } from "../usage/usage.service"
import { KeybDeductDto } from "./dto/keyb-deduct.dto"
import { KeybCreditService, keybInternalRequestId } from "./keyb-credit.service"

const TEST_KEY = "zk-unit-test-only-not-a-real-key"
const feature = {
  source: "listing.generate",
  label: "Listing 生成",
  module: "listing",
  moduleLabel: "Listing",
}
const app = {
  id: 1,
  appId: "api-test",
  appSecret: "unit-test-secret",
  name: "测试 API",
  status: "ACTIVE",
  perCallMaxCny: new Decimal("10"),
  keybProjectCodes: ["selleros"],
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies OpenApiApp

function body(overrides: Partial<KeybDeductDto> = {}): KeybDeductDto {
  return {
    costCny: "0.000001",
    source: "listing.generate",
    model: "model-test",
    requestId: "task-123-charge-1",
    meta: { taskId: "task-123", channel: "api" },
    ...overrides,
  }
}

describe("KeybCreditService（模拟依赖，不代表真实数据库或跨服务联调）", () => {
  const prisma = { usageLog: { findUnique: jest.fn() } }
  const usage = { chargeModel: jest.fn() }
  const keys = { resolveForDeduction: jest.fn() }
  const features = { ensureFresh: jest.fn(), get: jest.fn() }
  let service: KeybCreditService
  let stored: Record<string, unknown> | null

  beforeEach(async () => {
    jest.clearAllMocks()
    stored = null
    keys.resolveForDeduction.mockResolvedValue({
      userId: 100,
      projectCode: "selleros",
      externalProjectId: "project-1",
    })
    features.ensureFresh.mockResolvedValue(undefined)
    features.get.mockReturnValue(feature)
    prisma.usageLog.findUnique.mockImplementation(() => stored)
    usage.chargeModel.mockImplementation(
      (userId: number, cost: Decimal, params: ChargeModelParams): Promise<ChargeModelResult> => {
        stored = {
          userId,
          cost,
          credits: new Decimal("1"),
          balanceAfter: new Decimal("99"),
          source: params.source,
          meta: { ...params.meta, model: params.model, module: feature.module },
        }
        return Promise.resolve({
          costCny: cost,
          creditsCharged: new Decimal("1"),
          balance: new Decimal("99"),
          breakdown: [{ bucket: "GIFT", amount: "1" }],
          source: params.source,
          sourceLabel: feature.label,
          module: feature.module,
          moduleLabel: feature.moduleLabel,
          model: params.model,
          requestId: params.requestId ?? null,
          duplicate: false,
        })
      }
    )
    const module = await Test.createTestingModule({
      providers: [
        KeybCreditService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsageService, useValue: usage },
        { provide: SkillsKeysService, useValue: keys },
        { provide: FeatureRegistryService, useValue: features },
      ],
    }).compile()
    service = module.get(KeybCreditService)
  })

  it("由已校验的 KeyB 找人，把六位小额费用作为 Decimal 交给唯一既有扣费入口", async () => {
    const result = await service.deduct(app, TEST_KEY, body())
    expect(keys.resolveForDeduction).toHaveBeenCalledWith(TEST_KEY, app.appId)
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
    expect(usage.chargeModel).toHaveBeenCalledWith(
      100,
      new Decimal("0.000001"),
      expect.objectContaining({
        source: "listing.generate",
        model: "model-test",
        requestId: keybInternalRequestId(app.appId, "selleros", body().requestId),
        meta: expect.objectContaining({
          appId: app.appId,
          taskId: "task-123",
          keybCharge: expect.objectContaining({ userId: 100, costCny: "0.000001" }) as unknown,
        }) as unknown,
      })
    )
    const [, , params] = usage.chargeModel.mock.calls[0] as [number, Decimal, ChargeModelParams]
    expect(params).not.toHaveProperty("allowOverdraft")
    expect(JSON.stringify(params)).not.toContain(TEST_KEY)
    expect(result.costCny.toString()).toBe("0.000001")
    expect(result.requestId).toBe(body().requestId)
    expect(result.duplicate).toBe(false)
  })

  it("返回内核的资金路由、折扣、积分和余额结果，不重新计价或合并余额", async () => {
    usage.chargeModel.mockResolvedValue({
      costCny: new Decimal("0.35"),
      creditsCharged: new Decimal("6"),
      balance: new Decimal("17"),
      breakdown: [{ bucket: "GIFT", amount: "2" }],
      source: feature.source,
      sourceLabel: feature.label,
      module: feature.module,
      moduleLabel: feature.moduleLabel,
      model: "model-test",
      requestId: "internal-key",
      duplicate: false,
    })
    const result = await service.deduct(app, TEST_KEY, body({ costCny: "0.35" }))
    expect(result.creditsCharged.toString()).toBe("6")
    expect(result.balance.toString()).toBe("17")
    expect(result.breakdown[0].amount.toString()).toBe("2")
  })

  it("相同业务编号及规范化金额重试只读首次结果，保留首次模型、标签及余额", async () => {
    await service.deduct(app, TEST_KEY, body({ costCny: "0.350000" }))
    features.get.mockReturnValue({ ...feature, label: "后来更新的标签" })
    const result = await service.deduct(
      { ...app, perCallMaxCny: new Decimal("0.01") },
      "zk-new-unit-test-key",
      body({ costCny: "0.35" })
    )
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
    expect(result.duplicate).toBe(true)
    expect(result.costCny.toString()).toBe("0.35")
    expect(result.sourceLabel).toBe("Listing 生成")
    expect(result.model).toBe("model-test")
    expect(result.balance.toString()).toBe("99")
    expect(result.breakdown).toEqual([])
  })

  it.each([{ costCny: "0.35" }, { source: "listing.score" }, { model: "other-model" }])(
    "相同消费编号不同载荷 %j 返回409且不调用内核",
    async overrides => {
      await service.deduct(app, TEST_KEY, body())
      await expect(service.deduct(app, TEST_KEY, body(overrides))).rejects.toMatchObject({
        status: 409,
      })
      expect(usage.chargeModel).toHaveBeenCalledTimes(1)
    }
  )

  it("相同消费编号换用户返回409，不能借换Key绕过归属检查", async () => {
    await service.deduct(app, TEST_KEY, body())
    keys.resolveForDeduction.mockResolvedValue({
      userId: 101,
      projectCode: "selleros",
      externalProjectId: "project-1",
    })
    await expect(service.deduct(app, "zk-other-unit-user", body())).rejects.toMatchObject({
      status: 409,
    })
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
  })

  it("无指纹存量记录及损坏的金额/用户/模型记录不能冒充成功", async () => {
    stored = {
      userId: 100,
      cost: new Decimal("0.000001"),
      credits: new Decimal(1),
      balanceAfter: new Decimal(99),
      source: "listing.generate",
      meta: {},
    }
    await expect(service.deduct(app, TEST_KEY, body())).rejects.toMatchObject({ status: 409 })
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("内核并发返回duplicate后重读核对并返回已提交历史真值", async () => {
    await service.deduct(app, TEST_KEY, body())
    prisma.usageLog.findUnique.mockResolvedValueOnce(null)
    usage.chargeModel.mockResolvedValueOnce({ duplicate: true, creditsCharged: new Decimal(999) })
    const result = await service.deduct(app, TEST_KEY, body())
    expect(result.duplicate).toBe(true)
    expect(result.creditsCharged.toString()).toBe("1")
    expect(prisma.usageLog.findUnique).toHaveBeenCalledTimes(3)
  })

  it("内核并发duplicate的赢家若为另一用户，重查后409且绝不再扣一次", async () => {
    await service.deduct(app, TEST_KEY, body())
    stored = { ...stored, userId: 999 }
    prisma.usageLog.findUnique.mockResolvedValueOnce(null)
    usage.chargeModel.mockResolvedValueOnce({ duplicate: true })
    await expect(service.deduct(app, TEST_KEY, body())).rejects.toMatchObject({ status: 409 })
    expect(usage.chargeModel).toHaveBeenCalledTimes(2)
  })

  it("duplicate但无法找到已提交记录时返回可重试503，不伪造成功", async () => {
    usage.chargeModel.mockResolvedValueOnce({ duplicate: true })
    await expect(service.deduct(app, TEST_KEY, body())).rejects.toMatchObject({ status: 503 })
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
  })

  it("跨项目/接入方内部键隔离且长度小于64，元组编码不会分隔符碰撞", () => {
    const id = keybInternalRequestId("a", "project-1", "x".repeat(128))
    expect(id).toHaveLength(63)
    expect(id).not.toBe(keybInternalRequestId("a", "project-2", "x".repeat(128)))
    expect(id).not.toBe(keybInternalRequestId("b", "project-1", "x".repeat(128)))
    expect(keybInternalRequestId("a:b", "c", "d")).not.toBe(keybInternalRequestId("a", "b:c", "d"))
  })

  it.each(["0", "-1", "NaN", "Infinity", "1e-6", "0.0000001", "1000000", " 1", "1."])(
    "非法金额%s在读取凭证和扣费前被拒绝",
    async costCny => {
      await expect(service.deduct(app, TEST_KEY, body({ costCny }))).rejects.toMatchObject({
        status: 400,
      })
      expect(keys.resolveForDeduction).not.toHaveBeenCalled()
      expect(usage.chargeModel).not.toHaveBeenCalled()
    }
  )

  it("沿用已配置单笔上限，以Decimal精确比较", async () => {
    await expect(
      service.deduct(app, TEST_KEY, body({ costCny: "10.000001" }))
    ).rejects.toMatchObject({ status: 400 })
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it.each([
    { meta: { userId: 999 } },
    { meta: { keybCharge: { userId: 999 } } },
    { meta: { taskId: { key: TEST_KEY } } },
    { meta: { channel: TEST_KEY } },
    { meta: { taskId: Number.MAX_SAFE_INTEGER + 1 } },
    { model: "Bearer fake-credential" },
    { requestId: "task\nforged log" },
    { source: "sk_test_secret" },
  ])("拒绝可覆盖身份或携带敏感信息的参数 %j", async overrides => {
    await expect(service.deduct(app, TEST_KEY, body(overrides))).rejects.toMatchObject({
      status: 400,
    })
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("KeyB校验失败不查UsageLog、不回退手机号、不扣费", async () => {
    keys.resolveForDeduction.mockRejectedValue(new HttpException("凭证无效", 401))
    await expect(service.deduct(app, TEST_KEY, body())).rejects.toMatchObject({ status: 401 })
    expect(prisma.usageLog.findUnique).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("撤销项目授权后，即使存在首次成功记录也拒绝回放且不扣费", async () => {
    await service.deduct(app, TEST_KEY, body())
    prisma.usageLog.findUnique.mockClear()
    usage.chargeModel.mockClear()
    keys.resolveForDeduction.mockRejectedValue(
      new HttpException(
        { code: "SKILLS_PROJECT_FORBIDDEN", message: "接入方无此项目扣费权限" },
        403
      )
    )

    await expect(service.deduct(app, TEST_KEY, body())).rejects.toMatchObject({
      status: 403,
      response: { code: "SKILLS_PROJECT_FORBIDDEN" },
    })
    expect(prisma.usageLog.findUnique).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("余额不足、团队配额或注册来源等内核业务错误保留原语义且不自动重扣", async () => {
    const error = new BadRequestException("积分余额不足，请充值")
    usage.chargeModel.mockRejectedValue(error)
    await expect(service.deduct(app, TEST_KEY, body())).rejects.toBe(error)
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
  })

  it("数据库/未知错误转换安全503，原始凭证不进入日志或响应", async () => {
    const log = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    prisma.usageLog.findUnique.mockRejectedValueOnce(new Error(`query with secret=${TEST_KEY}`))
    try {
      await expect(service.deduct(app, TEST_KEY, body())).rejects.toMatchObject({
        status: 503,
        response: { code: "KEYB_CHARGE_UNAVAILABLE" },
      })
      expect(JSON.stringify(log.mock.calls)).not.toContain(TEST_KEY)
      expect(usage.chargeModel).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
