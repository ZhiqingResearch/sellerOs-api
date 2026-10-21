import { Prisma, PrismaClient } from "@prisma/client"
import {
  mainOpenApiApp,
  parseOpenApiAppArgs,
  runOpenApiAppCommand,
} from "../../scripts/create-open-api-app"

describe("OpenApiApp 管理脚本参数", () => {
  it.each(["grant-niuniu-plan", "revoke-niuniu-plan"])("解析牛牛接口权限：%s", action => {
    expect(parseOpenApiAppArgs([`--${action}`, "app-1"])).toEqual({ action, appId: "app-1" })
  })
  it("兼容原创建命令，默认无 KeyB 权限", () => {
    expect(parseOpenApiAppArgs(["Skills API"])).toEqual({
      action: "create",
      name: "Skills API",
      perCallMaxCny: null,
      keybProjectCodes: [],
    })
    expect(parseOpenApiAppArgs(["ERP", "100"])).toMatchObject({ perCallMaxCny: 100 })
  })

  it.each([
    [["Skills API", "--keyb-project", "selleros"], null],
    [["Skills API", "100", "--keyb-project", "selleros"], 100],
  ])("创建可显式授予项目权限：%j", (args, limit) => {
    expect(parseOpenApiAppArgs(args)).toMatchObject({
      action: "create",
      perCallMaxCny: limit,
      keybProjectCodes: ["selleros"],
    })
  })

  it.each(["grant-keyb", "revoke-keyb"])("解析 %s", action => {
    expect(parseOpenApiAppArgs([`--${action}`, "app-1", "selleros"])).toEqual({
      action,
      appId: "app-1",
      projectCode: "selleros",
    })
  })

  it.each([
    [],
    ["--unknown"],
    ["--grant-niuniu-plan"],
    ["--revoke-niuniu-plan", "app-1", "extra"],
    ["--list", "extra"],
    ["--help", "extra"],
    ["--disable"],
    ["--disable", "app-1", "extra"],
    ["--grant-keyb", "app-1"],
    ["--grant-keyb", "app-1", "selleros", "extra"],
    ["--grant-keyb", "app-1", "unknown"],
    ["--revoke-keyb", "app-1", "SELLEROS"],
    ["--grant-keyb", "app\n1", "selleros"],
    ["--grant-keyb", "app-1\n", "selleros"],
    ["Skills API", "--unknown"],
    ["Skills API", "100", "extra"],
    ["Skills API", "--keyb-project"],
    ["Skills API", "--keyb-project", "unknown"],
    ["Skills API", "--keyb-project", "selleros", "--keyb-project", "selleros"],
    ["Skills API", "-1"],
    ["Skills API", "0"],
    ["Skills API", "NaN"],
    ["Skills API", "Infinity"],
    ["   "],
    ["a".repeat(51)],
  ])("拒绝未知、缺失、多余或非法参数：%j", (...args) => {
    expect(() => parseOpenApiAppArgs(args)).toThrow()
  })
})

describe("OpenApiApp 管理脚本执行（仅 mock，无数据库连接）", () => {
  function setup(initialCodes: Prisma.JsonValue = []) {
    const state = { id: 1, keybProjectCodes: initialCodes }
    const output = { log: jest.fn(), table: jest.fn(), error: jest.fn() }
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([{ ...state }])),
      openApiApp: {
        update: jest.fn().mockImplementation((input: { data: { keybProjectCodes: string[] } }) => {
          state.keybProjectCodes = input.data.keybProjectCodes
          return Promise.resolve(state)
        }),
      },
    }
    const database = {
      openApiApp: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((callback: (value: typeof tx) => Promise<void>) => callback(tx)),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    }
    const prisma = database as unknown as PrismaClient
    return { state, output, tx, database, prisma }
  }

  it.each([[], ["--keyb-project", "selleros"]])("创建与授权一次入库：%j", (...options) => {
    const { prisma, database, output } = setup()
    const command = parseOpenApiAppArgs(["Skills API", ...options])
    return runOpenApiAppCommand(command, prisma, output).then(() => {
      expect(database.openApiApp.create).toHaveBeenCalledWith({
        data: {
          appId: expect.stringMatching(/^[a-f0-9]{16}$/) as unknown,
          appSecret: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
          name: "Skills API",
          perCallMaxCny: null,
          keybProjectCodes: options.length ? ["selleros"] : [],
        },
      })
      expect(output.log).toHaveBeenCalledTimes(1)
      expect(database.$transaction).not.toHaveBeenCalled()
    })
  })

  it("给现有服务授权后重复授权不写库，保留其他项目权限", async () => {
    const { prisma, database, tx, state, output } = setup(["future-project"])
    const command = parseOpenApiAppArgs(["--grant-keyb", "app-1", "selleros"])
    await runOpenApiAppCommand(command, prisma, output)
    await runOpenApiAppCommand(command, prisma, output)
    expect(state.keybProjectCodes).toEqual(["future-project", "selleros"])
    expect(database.$transaction).toHaveBeenCalledTimes(2)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.$queryRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("FOR UPDATE")]),
      "app-1"
    )
    expect(tx.openApiApp.update).toHaveBeenCalledTimes(1)
    expect(tx.openApiApp.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { keybProjectCodes: ["future-project", "selleros"] },
    })
    expect(database.openApiApp.create).not.toHaveBeenCalled()
    expect(database.openApiApp.updateMany).not.toHaveBeenCalled()
  })

  it.each(["grant-niuniu-plan", "revoke-niuniu-plan"])(
    "牛牛权限开关只更新自身字段：%s",
    async action => {
      const { prisma, database, output } = setup(["selleros"])
      await runOpenApiAppCommand(parseOpenApiAppArgs([`--${action}`, "app-1"]), prisma, output)
      expect(database.openApiApp.updateMany).toHaveBeenCalledWith({
        where: { appId: "app-1" },
        data: { isNiuniuOperationPlanEnabled: action === "grant-niuniu-plan" },
      })
      expect(database.openApiApp.create).not.toHaveBeenCalled()
    }
  )

  it("撤权幂等，仅移除指定项目且不改变服务身份、状态或上限", async () => {
    const { prisma, tx, state, output } = setup(["selleros", "future-project"])
    const command = parseOpenApiAppArgs(["--revoke-keyb", "app-1", "selleros"])
    await runOpenApiAppCommand(command, prisma, output)
    await runOpenApiAppCommand(command, prisma, output)
    expect(state.keybProjectCodes).toEqual(["future-project"])
    expect(tx.openApiApp.update).toHaveBeenCalledTimes(1)
    expect(tx.openApiApp.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { keybProjectCodes: ["future-project"] },
    })
  })

  it("行不存在则失败，不写权限", async () => {
    const { prisma, tx, output } = setup()
    tx.$queryRaw.mockResolvedValue([])
    await expect(
      runOpenApiAppCommand(
        parseOpenApiAppArgs(["--grant-keyb", "app-1", "selleros"]),
        prisma,
        output
      )
    ).rejects.toThrow("接入方不存在")
    expect(tx.openApiApp.update).not.toHaveBeenCalled()
    expect(output.log).not.toHaveBeenCalled()
  })

  it.each([null, "selleros", { selleros: true }, ["selleros", 1]].map(value => [value]))(
    "权限数据损坏时拒绝覆盖：%j",
    async value => {
      const { prisma, tx, output } = setup(value)
      await expect(
        runOpenApiAppCommand(
          parseOpenApiAppArgs(["--grant-keyb", "app-1", "selleros"]),
          prisma,
          output
        )
      ).rejects.toThrow("项目权限数据格式异常")
      expect(tx.openApiApp.update).not.toHaveBeenCalled()
    }
  )

  it("列表只查询安全字段，显示权限和单笔上限", async () => {
    const { prisma, database, output } = setup()
    database.openApiApp.findMany.mockResolvedValue([
      { appId: "app-1", keybProjectCodes: ["selleros"], perCallMaxCny: new Prisma.Decimal(100) },
      { appId: "app-2", keybProjectCodes: [], perCallMaxCny: null },
    ])
    await runOpenApiAppCommand(parseOpenApiAppArgs(["--list"]), prisma, output)
    expect(database.openApiApp.findMany).toHaveBeenCalledWith({
      select: {
        appId: true,
        name: true,
        status: true,
        perCallMaxCny: true,
        keybProjectCodes: true,
        isNiuniuOperationPlanEnabled: true,
        createdAt: true,
      },
      orderBy: { id: "asc" },
    })
    expect(output.table).toHaveBeenCalledWith([
      { appId: "app-1", keybProjectCodes: "selleros", perCallMaxCny: "100" },
      { appId: "app-2", keybProjectCodes: "无", perCallMaxCny: null },
    ])
  })

  it("保留停用命令，仅更新状态", async () => {
    const { prisma, database, output } = setup()
    await runOpenApiAppCommand(parseOpenApiAppArgs(["--disable", "app-1"]), prisma, output)
    expect(database.openApiApp.updateMany).toHaveBeenCalledWith({
      where: { appId: "app-1" },
      data: { status: "DISABLED" },
    })
  })

  it("帮助及非法参数不创建数据库客户端", async () => {
    const { prisma, output } = setup()
    const factory = jest.fn(() => prisma)
    await expect(mainOpenApiApp(["--help"], factory, output)).resolves.toBe(0)
    await expect(mainOpenApiApp(["-h"], factory, output)).resolves.toBe(0)
    await expect(mainOpenApiApp(["--unknown"], factory, output)).resolves.toBe(1)
    expect(factory).not.toHaveBeenCalled()
  })

  it("数据库失败不打印原始错误、密钥或成功消息，仍关闭连接", async () => {
    const { prisma, database, output } = setup()
    database.openApiApp.create.mockRejectedValue(new Error("Prisma 参数 appSecret=DO_NOT_LOG"))
    await expect(mainOpenApiApp(["Skills API"], () => prisma, output)).resolves.toBe(1)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("敏感错误详情已隐藏"))
    expect(JSON.stringify(output.error.mock.calls)).not.toContain("DO_NOT_LOG")
    expect(output.log).not.toHaveBeenCalled()
    expect(database.$disconnect).toHaveBeenCalledTimes(1)
  })

  it("执行成功后正常关闭连接", async () => {
    const { prisma, database, output } = setup()
    await expect(mainOpenApiApp(["--list"], () => prisma, output)).resolves.toBe(0)
    expect(database.$disconnect).toHaveBeenCalledTimes(1)
  })
})
