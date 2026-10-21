/**
 * 专用 MySQL 测试：默认跳过。本文件不创建/同步 schema，不读取 .env。
 * 仅在明确授权后，以 RUN_KEYB_DB_TESTS=1 + TEST_DATABASE_URL 运行。
 * 只接受 localhost 上 selleros_keyb_test 或 selleros_keyb_test_* 专用库。
 * 使用真实 UsageService / CreditService / MySQL 事务，凭证解析仍为隔离测试替身。
 */
import { OpenApiApp, Prisma, PrismaClient } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { randomUUID } from "crypto"
import { CreditService } from "../membership/credit.service"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import { SkillsKeysService } from "../skills-keys/skills-keys.service"
import { TeamModelConfigService } from "../team/team-model-config.service"
import { TeamQuotaService } from "../team/team-quota.service"
import { FeatureRegistryService } from "../usage/feature-registry.service"
import { UsageService } from "../usage/usage.service"
import { KeybCreditService } from "./keyb-credit.service"

const runDatabaseTests = process.env.RUN_KEYB_DB_TESTS === "1"
const describeDatabase = runDatabaseTests ? describe : describe.skip

function isolatedDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL
  if (!value) throw new Error("专用数据库测试需要显式 TEST_DATABASE_URL")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("TEST_DATABASE_URL 格式不正确")
  }
  if (
    url.protocol !== "mysql:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/selleros_keyb_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    (process.env.DATABASE_URL && process.env.DATABASE_URL !== value)
  ) {
    throw new Error(
      "仅允许本机 selleros_keyb_test 专用数据库，禁止生产 DATABASE_URL 或额外连接参数"
    )
  }
  return value
}

/** 两个事务都完成无记录的首次查询后才能继续，确保测试真正触发唯一索引竞争。 */
function synchronizeFirstReads(usage: UsageService) {
  const probe = usage as unknown as {
    findLogByRequestId: (client: Prisma.TransactionClient, requestId: string) => Promise<unknown>
  }
  const original = probe.findLogByRequestId.bind(usage)
  let reads = 0
  let release: () => void = () => undefined
  const bothRead = new Promise<void>(resolve => {
    release = resolve
  })
  return jest.spyOn(probe, "findLogByRequestId").mockImplementation(async (client, requestId) => {
    const row = await original(client, requestId)
    reads += 1
    if (reads <= 2) {
      expect(row).toBeNull()
      if (reads === 2) release()
      await bothRead
    }
    return row
  })
}

describeDatabase("KeyB 真实 MySQL 并发/回滚（须单独授权；不代表跨服务联调）", () => {
  let db: PrismaClient
  let usage: UsageService
  let features: FeatureRegistryService
  let adapter: KeybCreditService
  let source: string
  let userIds: number[] = []
  const app: OpenApiApp = {
    id: 1,
    appId: "keyb-database-test",
    appSecret: "unused-test-secret",
    name: "数据库隔离测试",
    status: "ACTIVE",
    perCallMaxCny: null,
    keybProjectCodes: ["selleros-test"],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }

  beforeAll(async () => {
    // Prisma 6 默认会自动探测 .env；测试专用覆盖禁用其文件路径，连接只取上面验证后的显式 URL。
    const options = {
      datasourceUrl: isolatedDatabaseUrl(),
      errorFormat: "minimal" as const,
      __internal: {
        configOverride: (config: Record<string, unknown>) => ({
          ...config,
          relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null },
        }),
      },
    }
    // __internal 是当前 Prisma 6 运行时支持、公开类型未暴露的测试选项；升级 Prisma 时需复核。
    db = new PrismaClient(options)
    await db.$connect()
  })

  beforeEach(async () => {
    userIds = []
    source = `keyb-test.${randomUUID()}`
    await db.featureModule.create({
      data: { source, label: "KeyB 隔离测试", module: null, moduleLabel: null },
    })
    for (let i = 0; i < 2; i += 1) {
      const user = await db.user.create({
        data: {
          username: "KeyB 数据库测试用户",
          phone: `keyb-test-${randomUUID()}`,
          password: "unused-test-password",
          balance: 100,
          discount: 1,
          rebateEnabled: false,
        },
      })
      userIds.push(user.id)
      await db.creditLot.create({
        data: {
          userId: user.id,
          bucket: "RECHARGE",
          amount: 100,
          remaining: 100,
          sourceType: "MANUAL_ADJUST",
          sourceRef: source,
        },
      })
    }
    const prisma = db as unknown as PrismaService
    features = new FeatureRegistryService(prisma)
    await features.refresh()
    const unused = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("本测试不应调用团队/模型定价依赖")
        },
      }
    )
    usage = new UsageService(
      prisma,
      unused as PricingService,
      new CreditService(prisma),
      unused as TeamQuotaService,
      features,
      unused as TeamModelConfigService
    )
    const keys = {
      resolveForDeduction: (keyB: string) =>
        Promise.resolve({
          userId: keyB === "zk-database-test-first" ? userIds[0] : userIds[1],
          projectCode: "selleros-test",
          externalProjectId: "external-test",
        }),
    } as unknown as SkillsKeysService
    adapter = new KeybCreditService(prisma, usage, keys, features)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    if (!db) return
    // 只清理由本次测试创建的用户数据，不操作其它账户或清空表。
    if (userIds.length) {
      await db.usageLog.deleteMany({ where: { userId: { in: userIds } } })
      await db.creditTransaction.deleteMany({ where: { userId: { in: userIds } } })
      await db.creditLot.deleteMany({ where: { userId: { in: userIds } } })
      await db.user.deleteMany({ where: { id: { in: userIds } } })
    }
    if (source) await db.featureModule.deleteMany({ where: { source } })
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  it("同用户并发撞P2002后，余额/批次/流水/UsageLog均只提交一次", async () => {
    const reads = synchronizeFirstReads(usage)
    const requestId = `keyb-db-${randomUUID()}`
    const results = await Promise.all([
      usage.chargeModel(userIds[0], "0.35", { source, model: "test-model", requestId }),
      usage.chargeModel(userIds[0], "0.35", { source, model: "test-model", requestId }),
    ])
    expect(reads).toHaveBeenCalledTimes(3) // 两次事务首查 + P2002 事务外重查
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true])
    expect(await db.usageLog.count({ where: { requestId } })).toBe(1)
    expect(await db.creditTransaction.count({ where: { userId: userIds[0] } })).toBe(1)
    const credit = new CreditService(db as unknown as PrismaService)
    expect((await credit.getConsumableBalance(userIds[0])).toString()).toBe("96")
    const lot = await db.creditLot.findFirstOrThrow({ where: { userId: userIds[0] } })
    expect(lot.remaining.toString()).toBe("96")
  }, 30000)

  it("跨用户同编号并发：仅赢家扣款，输家整体回滚并由接入指纹返回409", async () => {
    synchronizeFirstReads(usage)
    const dto = { costCny: "0.35", source, model: "test-model", requestId: randomUUID() }
    const results = await Promise.allSettled([
      adapter.deduct(app, "zk-database-test-first", dto),
      adapter.deduct(app, "zk-database-test-second", dto),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409 })
    const logs = await db.usageLog.findMany({ where: { userId: { in: userIds } } })
    expect(logs).toHaveLength(1)
    expect(await db.creditTransaction.count({ where: { userId: { in: userIds } } })).toBe(1)
    const winner = logs[0].userId
    const credit = new CreditService(db as unknown as PrismaService)
    for (const userId of userIds) {
      const balance = await credit.getConsumableBalance(userId)
      expect(balance.eq(new Decimal(userId === winner ? 96 : 100))).toBe(true)
    }
    const lots = await db.creditLot.findMany({ where: { userId: { in: userIds } } })
    for (const lot of lots) {
      expect(lot.remaining.toString()).toBe(lot.userId === winner ? "96" : "100")
    }
  }, 30000)
})
