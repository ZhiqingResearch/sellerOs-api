import { Test } from "@nestjs/testing"
import { CreditTxnType } from "@prisma/client"
import { describeTransaction } from "../membership/transaction-display"
import { PrismaService } from "../prisma/prisma.service"
import { FeatureRegistryService } from "./feature-registry.service"
import {
  getRegisteredFeature,
  getUsageSourceOptions,
  labelForSource,
  listRegisteredFeatures,
} from "./usage-source-labels"

describe("FeatureRegistryService", () => {
  let service: FeatureRegistryService
  let prisma: {
    featureModule: {
      createMany: jest.Mock
      updateMany: jest.Mock
      findMany: jest.Mock
    }
  }

  const ROWS = [
    {
      source: "listing.generate",
      label: "Listing 生成",
      module: "listing",
      moduleLabel: "Listing",
    },
    { source: "quick.publish", label: "一键上架", module: null, moduleLabel: null },
  ]

  beforeEach(async () => {
    prisma = {
      featureModule: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue(ROWS),
      },
    }
    const module = await Test.createTestingModule({
      providers: [FeatureRegistryService, { provide: PrismaService, useValue: prisma }],
    }).compile()
    service = module.get(FeatureRegistryService)
    await service.refresh()
  })

  afterEach(() => {
    // 清空模块级缓存，避免污染其他用例（重新写入空表）
    prisma.featureModule.findMany.mockResolvedValue([])
    return service.refresh()
  })

  it("refresh 加载 active 行进缓存（sortOrder 升序查询）", () => {
    expect(prisma.featureModule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    )
    expect(service.get("listing.generate")).toEqual(ROWS[0])
    expect(service.list()).toHaveLength(2)
  })

  it("启动时补齐缺失功能后加载注册表", async () => {
    prisma.featureModule.createMany.mockResolvedValue({ count: 2 })
    prisma.featureModule.findMany.mockClear()

    await service.onModuleInit()

    expect(prisma.featureModule.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
    expect(prisma.featureModule.findMany).toHaveBeenCalledTimes(1)
  })

  it.each(["影刀 RPA 创作", "影刀RPA创作"])(
    "启动时修正旧名称 %s，历史明细和筛选同源",
    async label => {
      const feature = { source: "rpa-creation.generate", label, module: null, moduleLabel: null }
      prisma.featureModule.updateMany.mockImplementation(
        ({
          where,
          data,
        }: {
          where: { source: string; label: { in: string[] } }
          data: { label: string }
        }) => {
          if (where.source === feature.source && where.label.in.includes(feature.label)) {
            feature.label = data.label
            return Promise.resolve({ count: 1 })
          }
          return Promise.resolve({ count: 0 })
        }
      )
      prisma.featureModule.findMany.mockResolvedValue([feature])

      await service.onModuleInit()

      expect(prisma.featureModule.updateMany).toHaveBeenCalledWith({
        where: { source: "rpa-creation.generate", label: { in: ["影刀 RPA 创作", "影刀RPA创作"] } },
        data: { label: "内部创作" },
      })
      expect(service.get(feature.source)?.label).toBe("内部创作")
      expect(getUsageSourceOptions()).toContainEqual({ value: feature.source, label: "内部创作" })
      expect(
        describeTransaction({ type: CreditTxnType.CONSUME, source: feature.source, meta: null })
          .title
      ).toBe("内部创作")

      await service.onModuleInit()
      expect(feature.label).toBe("内部创作")
    }
  )

  it("ensureFresh：TTL 内不刷新，过期才重新查库", async () => {
    prisma.featureModule.findMany.mockClear()
    await service.ensureFresh()
    expect(prisma.featureModule.findMany).not.toHaveBeenCalled()

    // 人为把 loadedAt 拨到 2 分钟前
    ;(service as unknown as { loadedAt: number }).loadedAt = Date.now() - 120_000
    await service.ensureFresh()
    expect(prisma.featureModule.findMany).toHaveBeenCalledTimes(1)
  })

  it("刷新失败沿用旧缓存（不阻断扣费链路）", async () => {
    prisma.featureModule.findMany.mockRejectedValue(new Error("db down"))
    ;(service as unknown as { loadedAt: number }).loadedAt = Date.now() - 120_000
    await expect(service.ensureFresh()).resolves.toBeUndefined()
    expect(service.get("listing.generate")).toEqual(ROWS[0]) // 旧缓存仍在
  })

  it("注册表驱动 labelForSource / source-options（覆盖静态字典、新增 key）", () => {
    // 注册表命中
    expect(labelForSource("quick.publish")).toBe("一键上架")
    // 静态字典兜底（未注册的老 source）
    expect(labelForSource("ai.chat")).toBe("AI 问一问")
    expect(labelForSource("rpa-creation.generate")).toBe("内部创作")
    // 前缀兜底
    expect(labelForSource("listing.new_stuff")).toBe("Listing 生成")
    // 未知来源原样返回
    expect(labelForSource("zzz.unknown")).toBe("zzz.unknown")

    const opts = getUsageSourceOptions()
    expect(opts[0]).toEqual({ value: "", label: "全部" })
    expect(opts).toContainEqual({ value: "quick.publish", label: "一键上架" })
    expect(opts).toContainEqual({ value: "llm.generic", label: "通用 LLM" }) // 静态兜底仍保留
    expect(opts).toContainEqual({ value: "rpa-creation.generate", label: "内部创作" })
    expect(opts).toContainEqual({ value: "admin.recharge.manual", label: "手动调整" }) // 非消费来源尾部追加
  })
})

describe("usage-source-labels 注册表缓存读写", () => {
  it("未加载时 getRegisteredFeature/listRegisteredFeatures 安全返回空", () => {
    // 上一个 describe 的 afterEach 已把缓存置为空表；此处模拟「完全未加载」语义只断言不抛错
    expect(() => getRegisteredFeature("x.y")).not.toThrow()
    expect(Array.isArray(listRegisteredFeatures())).toBe(true)
  })
})
