import { Decimal } from "@prisma/client/runtime/library"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSwitchSource, runModelSwitch } from "../../scripts/switch-chetaidou-image-model"

describe("车泰斗模型切换与备份恢复", () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "chetaidou-model-test-"))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  function setup() {
    const row = {
      id: 1,
      publicId: "old-image",
      category: "CHETAIDOU_IMAGE",
      modality: "IMAGE",
      enabled: true,
      gatewayActive: true,
      displayName: "旧模型",
      execMode: "ASYNC",
      gatewayConfig: {},
      quoteConfig: null,
      priceMultiplier: new Decimal(3),
      fixedCredits: new Decimal(7),
      sortOrder: 2,
      syncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const rows: any[] = [row, { ...row, id: 2, category: "OTHER" }]
    const matches = (r: any, where: any) =>
      Object.entries(where).every(([key, value]) => r[key] === value)
    const db: any = {
      $queryRaw: jest.fn(),
      aiGatewayModel: {
        findMany: jest.fn(async ({ where }) =>
          rows.filter(r => matches(r, where)).map(r => ({ ...r }))
        ),
        updateMany: jest.fn(async ({ where, data }) => {
          for (const r of rows.filter(r => matches(r, where))) Object.assign(r, data)
          return { count: 1 }
        }),
        upsert: jest.fn(async ({ where, create, update }) => {
          const r = rows.find(r => matches(r, where.publicId_category))
          if (r) Object.assign(r, update)
          else rows.push({ id: 3, createdAt: new Date(), updatedAt: new Date(), ...create })
        }),
        update: jest.fn(async ({ where, data }) =>
          Object.assign(
            rows.find(r => matches(r, where.publicId_category)),
            data
          )
        ),
      },
    }
    db.$transaction = jest.fn(async (fn: any) => {
      const before = rows.map(r => ({ ...r }))
      try {
        return await fn(db)
      } catch (error) {
        rows.splice(0, rows.length, ...before)
        throw error
      }
    })
    const gateway: any = {
      models: {
        get: jest.fn().mockResolvedValue({
          display_name: "新模型",
          modality: "image",
          exec_mode: "async",
          facts: { modes: ["edit"] },
        }),
        requestSchema: jest
          .fn()
          .mockResolvedValue({ version: 1, request_schema: { type: "object", properties: {} } }),
        pricing: jest.fn().mockResolvedValue({}),
      },
    }
    const options = {
      from: "old-image",
      to: "gpt-image-2.5-sunburst",
      apply: false,
      backup: join(directory, "backup.json"),
    }
    return { db, rows, gateway, options }
  }
  it("错误 from 拒绝，多个模型可同时启用", () => {
    const { rows } = setup()
    expect(() =>
      assertSwitchSource(
        rows.filter(r => r.category === "CHETAIDOU_IMAGE"),
        "wrong",
        "new"
      )
    ).toThrow("--from")
    expect(
      assertSwitchSource([rows[0], { ...rows[0], publicId: "two" }] as any, "old-image", "new")
    ).toBe("SWITCH")
  })
  it("dry-run 不写库也不写备份", async () => {
    const { db, gateway, options } = setup()
    expect(await runModelSwitch(db, gateway, options)).toMatchObject({
      dryRun: true,
      priceMultiplier: "3",
      fixedCredits: "7",
    })
    expect(db.aiGatewayModel.updateMany).not.toHaveBeenCalled()
    await expect(readFile(options.backup)).rejects.toThrow()
  })
  it("切换只修改图片分类，价格继承、完整备份、恢复保留新模型行", async () => {
    const { db, rows, gateway, options } = setup()
    await runModelSwitch(db, gateway, { ...options, apply: true })
    expect(
      rows.find(r => r.publicId === "old-image" && r.category === "CHETAIDOU_IMAGE").enabled
    ).toBe(true)
    expect(rows.find(r => r.category === "OTHER").enabled).toBe(true)
    const target = rows.find(r => r.publicId === options.to)
    expect(target).toMatchObject({ enabled: true, gatewayActive: true })
    expect(String(target.fixedCredits)).toBe("7")
    const backup = JSON.parse(await readFile(options.backup, "utf8"))
    expect(backup.before).toHaveLength(0)
    expect(backup.after).toHaveLength(1)
    expect(
      await runModelSwitch(db, null, { ...options, restore: options.backup, apply: true })
    ).toMatchObject({ restored: true })
    expect(target.enabled).toBe(false)
    expect(rows[0].enabled).toBe(true)
  })
  it("切换后人为更改价格则拒绝恢复，不覆盖后续改动", async () => {
    const { db, rows, gateway, options } = setup()
    await runModelSwitch(db, gateway, { ...options, apply: true })
    rows.find(r => r.publicId === options.to).priceMultiplier = new Decimal(9)
    await expect(
      runModelSwitch(db, null, { ...options, restore: options.backup, apply: true })
    ).rejects.toThrow("后续变更")
    expect(rows.find(r => r.publicId === options.to).enabled).toBe(true)
  })
  it("重复切换幂等，不覆盖已有目标价格", async () => {
    const { db, rows, gateway, options } = setup()
    await runModelSwitch(db, gateway, { ...options, apply: true })
    rows.find(r => r.publicId === options.to).priceMultiplier = new Decimal(8)
    expect(await runModelSwitch(db, gateway, { ...options, apply: true })).toMatchObject({
      alreadyActive: true,
    })
    expect(gateway.models.get).toHaveBeenCalledTimes(1)
    expect(String(rows.find(r => r.publicId === options.to).priceMultiplier)).toBe("8")
  })
  it("备份文件已存在时整体回滚", async () => {
    const { db, rows, gateway, options } = setup()
    await writeFile(options.backup, "already exists")
    await expect(runModelSwitch(db, gateway, { ...options, apply: true })).rejects.toThrow()
    expect(rows.filter(r => r.category === "CHETAIDOU_IMAGE")).toHaveLength(1)
    expect(rows[0].enabled).toBe(true)
  })
})
