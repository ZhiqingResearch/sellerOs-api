import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Prisma, SkillsKeyCredential } from "@prisma/client"
import { randomBytes, randomUUID } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { SkillsKeyConfigService } from "./skills-key-config.service"
import { SkillsKeyCryptoService } from "./skills-key-crypto.service"
import { SkillsKeyIssueError, SkillsKeyIssuerService } from "./skills-key-issuer.service"
import { KEY_ROTATION_STALE_MS, SkillsKeysService } from "./skills-keys.service"

/** In-memory CAS model only: these tests do not establish MySQL locking/rollback guarantees. */
describe("SkillsKeysService (mock persistence)", () => {
  let row: SkillsKeyCredential | null
  let service: SkillsKeysService
  let crypto: SkillsKeyCryptoService
  let issuer: { issue: jest.Mock }
  let prisma: {
    user: { findUnique: jest.Mock }
    openApiApp: { findUnique: jest.Mock }
    skillsKeyCredential: { findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  }
  let key: string
  let values: Record<string, string>
  let warning: jest.SpyInstance
  const userId = 7
  const phone = "13800000000"
  const projectId = "project-test"
  const dto = (operationId = randomUUID()) => ({ projectCode: "selleros", operationId })

  beforeEach(() => {
    warning = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    row = null
    key = `zk-${randomBytes(24).toString("hex")}`
    values = {
      SKILLS_KEYS_API_ORIGIN: "https://skills.example.invalid",
      SKILLS_KEYS_PROJECT_ID: projectId,
      SKILLS_KEYS_PROJECT_KEY_A: randomBytes(32).toString("hex"),
      SKILLS_KEYS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    }
    const config = new SkillsKeyConfigService(new ConfigService(values))
    crypto = new SkillsKeyCryptoService(config)
    issuer = { issue: jest.fn().mockResolvedValue({ phone, key }) }
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: userId, phone, isActive: true }) },
      openApiApp: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { appId: string } }) => ({
          status: "ACTIVE",
          keybProjectCodes: where.appId === "test-api" ? ["selleros"] : [],
        })),
      },
      skillsKeyCredential: {
        findUnique: jest.fn().mockImplementation(
          ({
            where,
          }: {
            where: {
              keyHash?: string
              userId_projectCode?: { userId: number; projectCode: string }
            }
          }) => {
            if (!row) return null
            if (where.keyHash && where.keyHash !== row.keyHash) return null
            if (
              where.userId_projectCode &&
              (where.userId_projectCode.userId !== row.userId ||
                where.userId_projectCode.projectCode !== row.projectCode)
            )
              return null
            return { ...row }
          }
        ),
        create: jest.fn().mockImplementation(({ data }: { data: Partial<SkillsKeyCredential> }) => {
          if (row)
            throw new Prisma.PrismaClientKnownRequestError("test duplicate", {
              code: "P2002",
              clientVersion: "6",
            })
          row = {
            id: 1,
            keyCiphertext: null,
            keyHash: null,
            encryptionVersion: null,
            maskedKey: null,
            activatedAt: null,
            lastErrorCode: null,
            revision: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          } as SkillsKeyCredential
          return { ...row }
        }),
        updateMany: jest.fn().mockImplementation(
          ({
            where,
            data,
          }: {
            where: {
              id: number
              revision?: number
              operationId?: string
              status: string | { in: string[] }
            }
            data: Record<string, unknown>
          }) => {
            if (
              !row ||
              where.id !== row.id ||
              (where.revision !== undefined && where.revision !== row.revision) ||
              (where.operationId && where.operationId !== row.operationId)
            )
              return { count: 0 }
            if (
              typeof where.status === "string"
                ? row.status !== where.status
                : !where.status.in.includes(row.status)
            )
              return { count: 0 }
            const revision = data.revision ? row.revision + 1 : row.revision
            row = { ...row, ...data, revision, updatedAt: new Date() }
            return { count: 1 }
          }
        ),
      },
    }
    service = new SkillsKeysService(
      prisma as unknown as PrismaService,
      config,
      crypto,
      issuer as unknown as SkillsKeyIssuerService
    )
  })

  afterEach(() => jest.restoreAllMocks())

  function switchProject() {
    const next = new SkillsKeyConfigService(
      new ConfigService({
        ...values,
        SKILLS_KEYS_PROJECT_ID: "2",
        SKILLS_KEYS_PROJECT_KEY_A: "pk-new-project-test-only",
        SKILLS_KEYS_API_ORIGIN: "https://new-skills.example.invalid",
      })
    )
    service = new SkillsKeysService(
      prisma as unknown as PrismaService,
      next,
      crypto,
      issuer as unknown as SkillsKeyIssuerService
    )
  }

  it("项目变更后明确重置使用当前项目、KeyA 和地址，保存新关联及密文且不丢操作历史", async () => {
    const first = dto()
    await service.generate(userId, first)
    switchProject()
    expect(await service.status(userId)).toMatchObject({
      status: "SYNC_UNKNOWN",
      lastErrorCode: "SKILLS_PROJECT_CHANGED",
      maskedKey: null,
      recoveryMessage: "接入项目已变更，请主动重置密钥以使用当前项目",
    })
    await expect(service.reveal(userId, "selleros")).rejects.toMatchObject({
      response: { code: "SKILLS_PROJECT_CHANGED" },
    })
    await expect(service.generate(userId, dto())).rejects.toMatchObject({
      response: { code: "SKILLS_PROJECT_CHANGED" },
    })
    const nextKey = `zk-${randomBytes(24).toString("hex")}`
    const operation = dto()
    issuer.issue.mockImplementation(async () => {
      expect(row).toMatchObject({
        externalProjectId: "2",
        status: "ROTATING",
        keyHash: null,
        keyCiphertext: null,
        maskedKey: null,
      })
      await expect(service.reveal(userId, "selleros")).rejects.toMatchObject({
        response: { code: "SKILLS_KEY_ROTATING" },
      })
      await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
        response: { code: "SKILLS_KEY_INVALID" },
      })
      return { phone, key: nextKey }
    })
    expect(await service.generate(userId, operation, true)).toMatchObject({
      status: "ACTIVE",
      key: nextKey,
    })
    expect(issuer.issue).toHaveBeenLastCalledWith(
      {
        code: "selleros",
        projectId: "2",
        keyA: "pk-new-project-test-only",
        apiOrigin: "https://new-skills.example.invalid",
      },
      phone
    )
    expect(row).toMatchObject({
      externalProjectId: "2",
      status: "ACTIVE",
      usedOperationIds: [first.operationId, operation.operationId],
    })
    expect(crypto.decrypt(row!.keyCiphertext!, row!.encryptionVersion!, userId, "2")).toBe(nextKey)
    expect(() =>
      crypto.decrypt(row!.keyCiphertext!, row!.encryptionVersion!, userId, projectId)
    ).toThrow()
    expect(await service.reveal(userId, "selleros")).toMatchObject({ key: nextKey })
    expect(await service.generate(userId, operation, true)).toMatchObject({ key: nextKey })
    expect(await service.resolveForDeduction(nextKey, "test-api")).toMatchObject({
      externalProjectId: "2",
      userId,
    })
    await expect(service.generate(userId, first)).rejects.toMatchObject({
      response: { code: "SKILLS_OPERATION_SUPERSEDED" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(2)
  })

  it("切换项目后不能把旧重置 UUID 当成新重置，必须由用户发起新操作", async () => {
    await service.generate(userId, dto())
    const previousReset = dto()
    await service.generate(userId, previousReset, true)
    switchProject()
    await expect(service.generate(userId, previousReset, true)).rejects.toMatchObject({
      response: { code: "SKILLS_PROJECT_CHANGED" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(2)
  })

  it("项目切换的并发重置只签发一次，处理中其他请求不能再次切换项目", async () => {
    await service.generate(userId, dto())
    switchProject()
    let finish!: (value: { phone: string; key: string }) => void
    issuer.issue.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const operation = dto()
    const first = service.generate(userId, operation, true)
    for (let i = 0; i < 20 && !finish; i++) await Promise.resolve()
    expect(finish).toBeDefined()
    await expect(service.generate(userId, operation, true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_ROTATING" },
    })
    await expect(service.generate(userId, dto(), true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_ROTATING" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(2)
    finish({ phone, key: `zk-${randomBytes(24).toString("hex")}` })
    await first
  })

  it.each(["remote", "save"])("项目切换时 %s 失败不返回旧 Key、不重签", async stage => {
    await service.generate(userId, dto())
    switchProject()
    if (stage === "remote") issuer.issue.mockRejectedValue(new SkillsKeyIssueError("ISSUE_TIMEOUT"))
    else {
      const original = prisma.skillsKeyCredential.updateMany.getMockImplementation()!
      prisma.skillsKeyCredential.updateMany.mockImplementation(
        (args: { data: Record<string, unknown> }) => {
          if (args.data.status === "ACTIVE") throw new Error("mock save failure")
          return original(args) as { count: number }
        }
      )
    }
    const operation = dto()
    await expect(service.generate(userId, operation, true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    expect(row).toMatchObject({
      externalProjectId: "2",
      status: "SYNC_UNKNOWN",
      keyCiphertext: null,
      keyHash: null,
    })
    await expect(service.generate(userId, operation, true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    await expect(service.generate(userId, dto(), true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    await expect(service.reveal(userId, "selleros")).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(2)
  })

  it.each(["ROTATING", "SYNC_UNKNOWN"] as const)(
    "旧项目真实 %s 不被配置变更掩盖或绕过",
    async status => {
      await service.generate(userId, dto())
      row!.status = status
      row!.lastErrorCode = status === "SYNC_UNKNOWN" ? "ISSUE_TIMEOUT" : null
      switchProject()
      expect(await service.status(userId)).toMatchObject({
        status,
        lastErrorCode: row!.lastErrorCode,
      })
      await expect(service.generate(userId, dto(), true)).rejects.toMatchObject({
        response: {
          code: status === "ROTATING" ? "SKILLS_KEY_ROTATING" : "SKILLS_KEY_SYNC_UNKNOWN",
        },
      })
      expect(issuer.issue).toHaveBeenCalledTimes(1)
    }
  )

  it("目标项目手机号已占用时在签发前拒绝，不覆盖已有凭证", async () => {
    await service.generate(userId, dto())
    const before = { ...row }
    switchProject()
    prisma.skillsKeyCredential.updateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("mock association conflict", {
        code: "P2002",
        clientVersion: "6",
      })
    )
    await expect(service.generate(userId, dto(), true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_ASSOCIATION_CONFLICT" },
    })
    expect(prisma.skillsKeyCredential.updateMany.mock.lastCall).toMatchObject([
      { data: { externalProjectId: "2", issuedPhone: phone } },
    ])
    expect(row).toEqual(before)
    expect(issuer.issue).toHaveBeenCalledTimes(1)
  })

  it("binds trusted user data, encrypts persisted KeyB and only reveals on explicit actions", async () => {
    const result = await service.generate(userId, dto())
    expect(result.key).toBe(key)
    expect(issuer.issue).toHaveBeenCalledWith(expect.objectContaining({ projectId }), phone)
    expect(row?.keyCiphertext).not.toContain(key)
    expect(row?.keyHash).toBe(crypto.hash(key))
    expect(await service.status(userId)).toEqual(
      expect.objectContaining({ status: "ACTIVE", maskedKey: crypto.mask(key) })
    )
    expect(JSON.stringify(await service.status(userId))).not.toContain(key)
    expect(await service.reveal(userId, "selleros")).toEqual(expect.objectContaining({ key }))
    await expect(service.reveal(8, "selleros")).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_NOT_CREATED" },
    })
  })

  it("replays same operation without remote rotation; repeat generation needs explicit reset", async () => {
    const operation = dto()
    await service.generate(userId, operation)
    expect((await service.generate(userId, operation)).key).toBe(key)
    await expect(service.generate(userId, dto())).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_EXISTS" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(1)
  })

  it("rotates explicitly, rejects old key and superseded/cross-kind operation IDs", async () => {
    const first = dto()
    await service.generate(userId, first)
    await expect(service.generate(userId, first, true)).rejects.toMatchObject({
      response: { code: "SKILLS_OPERATION_CONFLICT" },
    })
    const next = `zk-${randomBytes(24).toString("hex")}`
    issuer.issue.mockResolvedValue({ phone, key: next })
    await service.generate(userId, dto(), true)
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_INVALID" },
    })
    await expect(service.generate(userId, first)).rejects.toMatchObject({
      response: { code: "SKILLS_OPERATION_SUPERSEDED" },
    })
    await expect(service.resolveForDeduction(next, "test-api")).resolves.toEqual({
      userId,
      projectCode: "selleros",
      externalProjectId: projectId,
    })
    expect(issuer.issue).toHaveBeenCalledTimes(2)
  })

  it("claims initial issuance once during parallel requests and fails closed while rotating", async () => {
    let finish!: (value: { phone: string; key: string }) => void
    issuer.issue.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const operation = dto()
    const first = service.generate(userId, operation)
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve()
    await expect(service.generate(userId, operation)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_ROTATING" },
    })
    await expect(service.generate(userId, dto(), true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_ROTATING" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(1)
    finish({ phone, key })
    await first
  })

  it("keeps old key unavailable during reset and marks unknown remote outcomes without retries", async () => {
    await service.generate(userId, dto())
    const operation = dto()
    issuer.issue.mockImplementation(async () => {
      await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
        response: { code: "SKILLS_KEY_INVALID" },
      })
      throw new Error("simulated upstream timeout")
    })
    await expect(service.generate(userId, operation, true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    expect(row?.status).toBe("SYNC_UNKNOWN")
    await expect(service.generate(userId, operation, true)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    await expect(service.reveal(userId, "selleros")).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(2)
  })

  it("does not report success if encrypted local save fails", async () => {
    const original = prisma.skillsKeyCredential.updateMany.getMockImplementation()!
    prisma.skillsKeyCredential.updateMany.mockImplementation(
      (args: { data: Record<string, unknown> }) => {
        if (args.data.status === "ACTIVE") throw new Error("simulated persistence failure")
        return original(args) as { count: number }
      }
    )
    const operation = dto()
    await expect(service.generate(userId, operation)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    expect(row?.status).toBe("SYNC_UNKNOWN")
    expect(row?.lastErrorCode).toBe("KEY_SAVE_FAILED")
    expect(row?.keyCiphertext).toBeNull()
    await expect(service.generate(userId, operation)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(1)
  })

  it.each([
    new SkillsKeyIssueError("ISSUE_TLS_ERROR", undefined, "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
    new SkillsKeyIssueError("ISSUE_HTTP_ERROR", 404),
    new SkillsKeyIssueError("ISSUE_RESPONSE_INVALID", 201),
  ])("保存安全的上游失败分类，409语义和禁止重签保持不变：%p", async failure => {
    issuer.issue.mockRejectedValue(failure)
    const operation = dto()
    await expect(service.generate(userId, operation)).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_SYNC_UNKNOWN" },
      status: 409,
    })
    expect(row?.lastErrorCode).toBe(failure.failureCode)
    expect(await service.status(userId)).toMatchObject({
      status: "SYNC_UNKNOWN",
      lastErrorCode: failure.failureCode,
    })
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "skills_key_issue_failed",
        operationId: operation.operationId,
        lastErrorCode: failure.failureCode,
        upstreamStatus: failure.upstreamStatus,
        transportCode: failure.transportCode,
      })
    )
    await expect(service.generate(userId, operation)).rejects.toMatchObject({ status: 409 })
    expect(issuer.issue).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it.each(["encrypt", "decrypt"] as const)(
    "区分本地%s阶段，日志不泄漏异常中的凭证或手机号",
    async method => {
      jest.spyOn(crypto, method).mockImplementation(() => {
        throw new Error(`private-error ${key} ${phone}`)
      })
      await expect(service.generate(userId, dto())).rejects.toMatchObject({ status: 409 })
      expect(row?.lastErrorCode).toBe(
        method === "encrypt" ? "KEY_ENCRYPT_FAILED" : "KEY_DELIVERY_FAILED"
      )
      expect(row?.status).toBe("SYNC_UNKNOWN")
      const logged = JSON.stringify(warning.mock.calls)
      expect(logged).not.toContain(key)
      expect(logged).not.toContain(phone)
      expect(logged).not.toContain("private-error")
      expect(issuer.issue).toHaveBeenCalledTimes(1)
    }
  )

  it("区分保存成功后的数据库回读失败，不把已保存密文作为成功交付", async () => {
    prisma.skillsKeyCredential.findUnique
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error(`private-read-error ${key}`))
    await expect(service.generate(userId, dto())).rejects.toMatchObject({ status: 409 })
    expect(row?.lastErrorCode).toBe("KEY_READBACK_FAILED")
    expect(row?.status).toBe("SYNC_UNKNOWN")
    expect(row?.keyCiphertext).toBeTruthy()
    expect(JSON.stringify(warning.mock.calls)).not.toContain(key)
  })

  it("保存条件更新未命中时留下冲突分类，保留待恢复状态", async () => {
    prisma.skillsKeyCredential.updateMany.mockReturnValueOnce({ count: 0 })
    await expect(service.generate(userId, dto())).rejects.toMatchObject({ status: 409 })
    expect(row?.lastErrorCode).toBe("KEY_SAVE_CONFLICT")
    expect(row?.status).toBe("SYNC_UNKNOWN")
    expect(issuer.issue).toHaveBeenCalledTimes(1)
  })

  it("marks stale in-progress operations unknown and rejects late response overwrite", async () => {
    let finish!: (value: { phone: string; key: string }) => void
    issuer.issue.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = service.generate(userId, dto())
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve()
    row!.operationStartedAt = new Date(Date.now() - KEY_ROTATION_STALE_MS - 1)
    expect(await service.status(userId)).toEqual(
      expect.objectContaining({ status: "SYNC_UNKNOWN" })
    )
    finish({ phone, key })
    await expect(pending).rejects.toMatchObject({ response: { code: "SKILLS_KEY_SYNC_UNKNOWN" } })
    expect(row?.status).toBe("SYNC_UNKNOWN")
    expect(row?.keyCiphertext).toBeNull()
  })

  it("rejects unapproved services, inactive users and changed project configuration", async () => {
    await service.generate(userId, dto())
    await expect(service.resolveForDeduction(key, "unapproved")).rejects.toMatchObject({
      response: { code: "SKILLS_PROJECT_FORBIDDEN" },
    })
    prisma.user.findUnique.mockResolvedValue({ id: userId, phone, isActive: false })
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "SKILLS_USER_INACTIVE" },
    })
    prisma.user.findUnique.mockResolvedValue({ id: userId, phone, isActive: true })
    row!.externalProjectId = "another-project"
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "SKILLS_KEY_INVALID" },
    })
    expect((await service.status(userId)).status).toBe("SYNC_UNKNOWN")
  })

  it.each(["12000000000", "13800000000\n", "not-a-phone"])(
    "rejects invalid trusted phone before issuance: %p",
    async invalidPhone => {
      prisma.user.findUnique.mockResolvedValue({ id: userId, phone: invalidPhone, isActive: true })
      await expect(service.generate(userId, dto())).rejects.toMatchObject({
        response: { code: "SKILLS_PHONE_INVALID" },
      })
      expect(issuer.issue).not.toHaveBeenCalled()
      expect(prisma.skillsKeyCredential.create).not.toHaveBeenCalled()
    }
  )

  it("reads changed database grants on the next request without recreating the service or KeyB", async () => {
    await service.generate(userId, dto())
    const app = { status: "ACTIVE", keybProjectCodes: [] as string[] }
    prisma.openApiApp.findUnique.mockImplementation(() => ({ ...app }))
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "SKILLS_PROJECT_FORBIDDEN" },
    })
    app.keybProjectCodes = ["selleros"]
    await expect(service.resolveForDeduction(key, "test-api")).resolves.toMatchObject({ userId })
    app.keybProjectCodes = []
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "SKILLS_PROJECT_FORBIDDEN" },
    })
    expect(prisma.openApiApp.findUnique).toHaveBeenCalledTimes(3)
    expect(prisma.openApiApp.findUnique).toHaveBeenLastCalledWith({
      where: { appId: "test-api" },
      select: { status: true, keybProjectCodes: true },
    })
    expect(issuer.issue).toHaveBeenCalledTimes(1)
  })

  it.each([null, "selleros", { selleros: true }, ["other-project"], ["*"], ["selleros", 1]])(
    "rejects missing, malformed or different-project grants: %j",
    async keybProjectCodes => {
      await service.generate(userId, dto())
      prisma.openApiApp.findUnique.mockResolvedValue({ status: "ACTIVE", keybProjectCodes })
      await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
        response: { code: "SKILLS_PROJECT_FORBIDDEN" },
      })
    }
  )

  it("does not let a project grant enable a disabled or deleted service", async () => {
    await service.generate(userId, dto())
    prisma.openApiApp.findUnique.mockResolvedValue({
      status: "DISABLED",
      keybProjectCodes: ["selleros"],
    })
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "OPEN_APP_DISABLED" },
    })
    prisma.openApiApp.findUnique.mockResolvedValue(null)
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: { code: "OPEN_AUTH_INVALID" },
    })
  })

  it("fails closed if grant lookup fails without exposing the raw database error", async () => {
    await service.generate(userId, dto())
    prisma.openApiApp.findUnique.mockRejectedValue(new Error("private database details"))
    await expect(service.resolveForDeduction(key, "test-api")).rejects.toMatchObject({
      response: {
        code: "SKILLS_KEYS_UNAVAILABLE",
        message: "密钥服务暂不可用，请保留 operationId 并稍后查询状态",
      },
    })
  })
})
