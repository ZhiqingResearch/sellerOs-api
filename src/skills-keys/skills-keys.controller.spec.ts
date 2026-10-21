import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common"
import { GUARDS_METADATA } from "@nestjs/common/constants"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { App } from "supertest/types"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { KeybCreditController } from "../open-api/keyb-credit.controller"
import { KeybCreditService } from "../open-api/keyb-credit.service"
import { OpenApiAuthGuard } from "../open-api/open-api-auth.guard"
import { OPEN_API_KEYB_SIGNATURE } from "../open-api/open-api-keyb-signature.decorator"
import { SkillsKeysController } from "./skills-keys.controller"
import { SkillsKeysService } from "./skills-keys.service"

const signedInUserId = 7
const projectCode = "selleros"
const operationId = "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c"
const testSession = "Bearer unit-test-session-not-a-real-jwt"
const testKey = "zk-controller-test-only-never-issued-credential"
const publicStatus = { projectCode, status: "ACTIVE", maskedKey: "zk-****tial" }

/** 内存 Nest HTTP 层验证：用户身份与业务服务均为 mock，不启动 AppModule/数据库或调用外部 API。 */
describe("SkillsKeysController HTTP", () => {
  let app: INestApplication<App>
  const service = { status: jest.fn(), generate: jest.fn(), reveal: jest.fn() }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SkillsKeysController],
      providers: [{ provide: SkillsKeysService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<{
            headers: Record<string, string | undefined>
            user?: { id: number }
          }>()
          if (req.headers.authorization !== testSession) {
            throw new UnauthorizedException("请先登录")
          }
          req.user = { id: signedInUserId }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
    await app.listen(0, "127.0.0.1")
  })

  beforeEach(() => {
    jest.clearAllMocks()
    service.status.mockResolvedValue(publicStatus)
    service.generate.mockResolvedValue({ ...publicStatus, operationId, key: testKey })
    service.reveal.mockResolvedValue({ ...publicStatus, key: testKey })
  })

  afterAll(async () => {
    await app.close()
  })

  it("状态路由只调用本人的状态服务，不返回原值或触发复制/签发", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/skills/keys")
      .query({ projectCode, userId: 999, phone: "13900000000", teamId: 99 })
      .set("Authorization", testSession)
      .expect(200)
      .expect("Cache-Control", "no-store")

    expect(response.body).toEqual(publicStatus)
    expect(response.body).not.toHaveProperty("key")
    expect(response.body).not.toHaveProperty("keyCiphertext")
    expect(response.body).not.toHaveProperty("keyHash")
    expect(response.text).not.toContain(testKey)
    expect(service.status).toHaveBeenCalledTimes(1)
    expect(service.status).toHaveBeenCalledWith(signedInUserId, projectCode)
    expect(service.generate).not.toHaveBeenCalled()
    expect(service.reveal).not.toHaveBeenCalled()
  })

  it("状态查询省略 projectCode 时由服务选择后端默认项目", async () => {
    await request(app.getHttpServer())
      .get("/api/skills/keys")
      .set("Authorization", testSession)
      .expect(200)
    expect(service.status).toHaveBeenCalledTimes(1)
    expect(service.status).toHaveBeenCalledWith(signedInUserId, undefined)
  })

  it("生成只传当前用户和白名单 DTO，前端不能指定消费人、手机号、KeyA 或强制重置", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/skills/keys")
      .set("Authorization", testSession)
      .send({
        projectCode,
        operationId,
        userId: 999,
        phone: "13900000000",
        teamId: 99,
        keyA: "test-only-injected-project-key",
        reset: true,
      })
      .expect(201)
      .expect("Cache-Control", "no-store")

    expect(response.body).toEqual({ ...publicStatus, operationId, key: testKey })
    expect(response.text).not.toContain("test-only-injected-project-key")
    expect(service.generate).toHaveBeenCalledTimes(1)
    expect(service.generate).toHaveBeenCalledWith(signedInUserId, {
      projectCode,
      operationId,
    })
  })

  it("显式重置路径传 true，保持用户归属，并将 UUID 规范化供操作幂等使用", async () => {
    await request(app.getHttpServer())
      .post("/api/skills/keys/reset")
      .set("Authorization", testSession)
      .send({ projectCode, operationId: operationId.toUpperCase(), userId: 999, reset: false })
      .expect(201)
      .expect("Cache-Control", "no-store")

    expect(service.generate).toHaveBeenCalledTimes(1)
    expect(service.generate).toHaveBeenCalledWith(
      signedInUserId,
      { projectCode, operationId },
      true
    )
  })

  it("主动复制只读取当前用户的项目凭证，响应不可缓存", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/skills/keys/reveal")
      .set("Authorization", testSession)
      .send({ projectCode, userId: 999, phone: "13900000000", key: "zk-attacker-placeholder" })
      .expect(201)
      .expect("Cache-Control", "no-store")

    expect(response.body).toEqual({ ...publicStatus, key: testKey })
    expect(service.reveal).toHaveBeenCalledTimes(1)
    expect(service.reveal).toHaveBeenCalledWith(signedInUserId, projectCode)
    expect(service.generate).not.toHaveBeenCalled()
  })

  it.each([
    ["生成", "/api/skills/keys", "post"],
    ["状态", "/api/skills/keys", "get"],
    ["重置", "/api/skills/keys/reset", "post"],
    ["复制", "/api/skills/keys/reveal", "post"],
  ] as const)("%s路由必须先通过 JWT guard", async (_name, path, method) => {
    const req = request(app.getHttpServer())
    const pending =
      method === "get" ? req.get(path) : req.post(path).send({ projectCode, operationId })
    await pending.expect(401)
    expect(service.status).not.toHaveBeenCalled()
    expect(service.generate).not.toHaveBeenCalled()
    expect(service.reveal).not.toHaveBeenCalled()
  })

  it("仅持有 KeyB 不能代替 SellerOS JWT 申请或复制凭证", async () => {
    await request(app.getHttpServer())
      .post("/api/skills/keys/reveal")
      .set("Authorization", `Bearer ${testKey}`)
      .send({ projectCode })
      .expect(401)
    expect(service.reveal).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { projectCode },
    { projectCode, operationId: "invalid-operation-id" },
    { projectCode, operationId: null },
    { projectCode, operationId: 123 },
    { projectCode, operationId: `${operationId}\n` },
    { projectCode: "", operationId },
    { projectCode: "SellerOS", operationId },
    { projectCode: "../selleros", operationId },
    { projectCode: "selleros\n", operationId },
    { projectCode: "a".repeat(51), operationId },
    { projectCode: ["selleros"], operationId },
  ])("非法生成参数先返回400，不触发签发：%p", async body => {
    await request(app.getHttpServer())
      .post("/api/skills/keys")
      .set("Authorization", testSession)
      .send(body)
      .expect(400)
    expect(service.generate).not.toHaveBeenCalled()
  })

  it("重置也必须携带有效 operationId，不能因已有凭证跳过校验", async () => {
    await request(app.getHttpServer())
      .post("/api/skills/keys/reset")
      .set("Authorization", testSession)
      .send({ projectCode })
      .expect(400)
    expect(service.generate).not.toHaveBeenCalled()
  })

  it.each([{}, { projectCode: null }, { projectCode: 123 }, { projectCode: "../selleros" }])(
    "复制入口先校验必填项目：%p",
    async body => {
      await request(app.getHttpServer())
        .post("/api/skills/keys/reveal")
        .set("Authorization", testSession)
        .send(body)
        .expect(400)
      expect(service.reveal).not.toHaveBeenCalled()
    }
  )

  it.each(["", "SellerOS", "../selleros", "selleros\n", "a".repeat(51)])(
    "非法状态查询项目先返回400：%p",
    async invalidProject => {
      await request(app.getHttpServer())
        .get("/api/skills/keys")
        .query({ projectCode: invalidProject })
        .set("Authorization", testSession)
        .expect(400)
      expect(service.status).not.toHaveBeenCalled()
    }
  )

  it("格式合法但未获项目权限时保留服务的403，不签发其他项目", async () => {
    service.generate.mockRejectedValueOnce(
      new ForbiddenException({ code: "SKILLS_PROJECT_FORBIDDEN", message: "无权使用该接入项目" })
    )
    const response = await request(app.getHttpServer())
      .post("/api/skills/keys")
      .set("Authorization", testSession)
      .send({ projectCode: "another-project", operationId })
      .expect(403)
    expect(response.body).toMatchObject({ code: "SKILLS_PROJECT_FORBIDDEN" })
    expect(service.generate).toHaveBeenCalledTimes(1)
    expect(service.generate).toHaveBeenCalledWith(signedInUserId, {
      projectCode: "another-project",
      operationId,
    })
  })
})

describe("KeybCreditController HTTP wiring", () => {
  let app: INestApplication<App>
  const service = { deduct: jest.fn() }
  const verifiedApp = { appId: "test-api-app", status: "ACTIVE" }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [KeybCreditController],
      providers: [{ provide: KeybCreditService, useValue: service }],
    })
      .overrideGuard(OpenApiAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<{
            openApiApp?: typeof verifiedApp
            openApiKeyB?: string
          }>()
          req.openApiApp = verifiedApp
          req.openApiKeyB = testKey
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
    await app.listen(0, "127.0.0.1")
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    service.deduct.mockResolvedValue({
      costCny: "0.000001",
      creditsCharged: "1",
      requestId: "test-consumption-1",
      duplicate: false,
    })
  })

  it("仅新入口启用 v2 服务签名 metadata 与服务身份 guard", () => {
    expect(Reflect.getMetadata(OPEN_API_KEYB_SIGNATURE, KeybCreditController)).toBe(true)
    expect(Reflect.getMetadata(GUARDS_METADATA, KeybCreditController)).toContain(OpenApiAuthGuard)
  })

  it("将guard核定的身份和KeyB传给服务，前端身份字段不可覆盖，响应不缓存", async () => {
    const dto = {
      costCny: "0.000001",
      source: "listing.generate",
      model: "test-model",
      requestId: "test-consumption-1",
    }
    const response = await request(app.getHttpServer())
      .post("/api/open/keyb/credit/deduct")
      .send({
        ...dto,
        userId: 999,
        phone: "13900000000",
        teamId: 99,
        keyB: "zk-attacker-placeholder",
      })
      .expect(201)
      .expect("Cache-Control", "no-store")

    expect(service.deduct).toHaveBeenCalledTimes(1)
    expect(service.deduct).toHaveBeenCalledWith(verifiedApp, testKey, dto)
    expect(response.body).toMatchObject({ requestId: dto.requestId, duplicate: false })
    expect(response.text).not.toContain(testKey)
  })

  it.each([0.01, "0", "-0.01", "NaN", "Infinity", "0.0000001", "1000000", "1\n"])(
    "HTTP金额校验拒绝 %p 并且不调用扣费函数",
    async costCny => {
      await request(app.getHttpServer())
        .post("/api/open/keyb/credit/deduct")
        .send({ costCny, source: "listing.generate", model: "test-model", requestId: "test-id" })
        .expect(400)
      expect(service.deduct).not.toHaveBeenCalled()
    }
  )
})
