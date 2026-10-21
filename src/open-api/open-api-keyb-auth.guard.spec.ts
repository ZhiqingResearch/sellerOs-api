import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common"
import { createHash, createHmac } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { KeybOpenRequest, OPEN_SIGN_WINDOW_MS, OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenApiKeybSignature } from "./open-api-keyb-signature.decorator"

@OpenApiKeybSignature()
class KeybController {
  deduct(this: void) {}
}

function ctxOf(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => KeybController,
    getHandler: () => KeybController.prototype.deduct,
  } as unknown as ExecutionContext
}

interface TestRequest extends Record<string, unknown> {
  headers: Record<string, string | string[] | undefined>
  rawBody?: Buffer
  method: string
  originalUrl: string
}

// API 调用方按公开规范签名，不使用 guard 内部实现。
function signRequest(req: TestRequest, secret = "service-secret-test-only") {
  const headers = req.headers
  const keyB = (headers.authorization as string).slice("Bearer ".length)
  const payload = [
    "v2",
    req.method.toUpperCase(),
    req.originalUrl,
    headers["x-app-id"],
    headers["x-timestamp"],
    headers["x-nonce"],
    createHash("sha256").update(keyB).digest("hex"),
    createHash("sha256")
      .update(req.rawBody ?? "")
      .digest("hex"),
  ].join("\n")
  req.headers["x-sign"] = createHmac("sha256", secret).update(payload).digest("hex")
  return req
}

describe("OpenApiAuthGuard KeyB v2", () => {
  const APP = {
    id: 1,
    appId: "api-test",
    appSecret: "service-secret-test-only",
    name: "测试 API",
    status: "ACTIVE",
    perCallMaxCny: null,
  }
  const KEY = "zk-fake-keyb-for-unit-test"
  let prisma: { openApiApp: { findUnique: jest.Mock } }
  let guard: OpenApiAuthGuard

  beforeEach(() => {
    prisma = { openApiApp: { findUnique: jest.fn().mockResolvedValue(APP) } }
    guard = new OpenApiAuthGuard(prisma as unknown as PrismaService)
  })

  const validReq = (): TestRequest =>
    signRequest({
      method: "POST",
      originalUrl: "/api/open/keyb/credit/deduct",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json; charset=utf-8",
        "x-sign-version": "v2",
        "x-app-id": "api-test",
        "x-timestamp": String(Date.now()),
        "x-nonce": "unit-test-nonce",
      },
      rawBody: Buffer.from(
        '{ "costCny": "0.000001", "source": "listing", "model": "test-model", "requestId": "test-request", "meta": {"taskId": "测试任务"} }'
      ),
    })

  it("合法签名放行并提供服务身份和不可枚举的用户凭证", async () => {
    const req = validReq()
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true)
    expect((req as unknown as KeybOpenRequest).openApiApp).toBe(APP)
    expect((req as unknown as KeybOpenRequest).openApiKeyB).toBe(KEY)
    expect(Object.keys(req)).not.toContain("openApiKeyB")
  })

  it("兼容历史 sk_ 凭证", async () => {
    const req = validReq()
    req.headers.authorization = "Bearer sk_fake-historical-key-for-unit-test"
    signRequest(req)
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true)
  })

  it.each([
    ["KeyB", (req: TestRequest) => (req.headers.authorization = "Bearer zk-other-test-key")],
    [
      "金额",
      (req: TestRequest) =>
        (req.rawBody = Buffer.from(req.rawBody!.toString().replace("0.000001", "9.000001"))),
    ],
    [
      "消费编号",
      (req: TestRequest) =>
        (req.rawBody = Buffer.from(
          req.rawBody!.toString().replace("test-request", "other-request")
        )),
    ],
    ["请求路径", (req: TestRequest) => (req.originalUrl = "/api/open/credit/deduct")],
    ["请求方法", (req: TestRequest) => (req.method = "PUT")],
    ["接入方", (req: TestRequest) => (req.headers["x-app-id"] = "other-app")],
    [
      "时间戳",
      (req: TestRequest) =>
        (req.headers["x-timestamp"] = String(Number(req.headers["x-timestamp"]) - 1000)),
    ],
    ["nonce", (req: TestRequest) => (req.headers["x-nonce"] = "other-nonce")],
    [
      "JSON 字节",
      (req: TestRequest) =>
        (req.rawBody = Buffer.from(JSON.stringify(JSON.parse(req.rawBody!.toString())))),
    ],
  ])("签名后替换%s → 401", async (_name, change) => {
    const req = validReq()
    change(req)
    await expect(guard.canActivate(ctxOf(req))).rejects.toMatchObject({
      response: { code: "OPEN_AUTH_INVALID" },
    })
    expect(req.openApiApp).toBeUndefined()
    expect(req.openApiKeyB).toBeUndefined()
  })

  it("只有 KeyB 没有服务签名 → 401，不查询数据库", async () => {
    const req = validReq()
    delete req.headers["x-sign"]
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
    expect(prisma.openApiApp.findUnique).not.toHaveBeenCalled()
  })

  it("只有服务签名没有 KeyB → 401", async () => {
    const req = validReq()
    delete req.headers.authorization
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it("未注明 v2 或用旧版签名不能降级通过新入口", async () => {
    const req = validReq()
    delete req.headers["x-sign-version"]
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
    req.headers["x-sign-version"] = "v2"
    const bodyHash = createHash("sha256").update(req.rawBody!).digest("hex")
    req.headers["x-sign"] = createHmac("sha256", APP.appSecret)
      .update([APP.appId, req.headers["x-timestamp"], req.headers["x-nonce"], bodyHash].join("\n"))
      .digest("hex")
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it.each([
    ["签名截短", "x-sign", "a".repeat(63)],
    ["签名非十六进制", "x-sign", "z".repeat(64)],
    ["签名数组", "x-sign", ["a".repeat(64)]],
    ["接入方换行", "x-app-id", "api-test\nextra"],
    ["nonce 超长", "x-nonce", "n".repeat(129)],
    ["时间戳指数形式", "x-timestamp", "1e12"],
    ["凭证超长", "authorization", `Bearer zk-${"a".repeat(510)}`],
    ["凭证重复", "authorization", `Bearer ${KEY}, Bearer ${KEY}`],
    ["表单载荷", "content-type", "application/x-www-form-urlencoded"],
  ])("%s → 401，不回显敏感信息", async (_name, header, value) => {
    const req = validReq()
    req.headers[header] = value
    await expect(guard.canActivate(ctxOf(req))).rejects.toMatchObject({
      response: {
        code: "OPEN_AUTH_INVALID",
        message: "服务签名或用户凭证格式无效",
      },
    })
    expect(prisma.openApiApp.findUnique).not.toHaveBeenCalled()
  })

  it("Node 忽略或合并的重复原始鉴权头也会拒绝", async () => {
    const req = validReq()
    req.rawHeaders = ["Authorization", `Bearer ${KEY}`, "authorization", `Bearer ${KEY}`]
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it("缺少原始 body 时不允许签空串冒充 JSON 请求", async () => {
    const req = validReq()
    req.body = JSON.parse(req.rawBody!.toString())
    delete req.rawBody
    signRequest(req)
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it("即使已签名也拒绝 query", async () => {
    const req = validReq()
    req.originalUrl += "?unused=true"
    signRequest(req)
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it.each([-1, 1])("超出过去或未来 5 分钟时间窗 → 401", async direction => {
    const req = validReq()
    req.headers["x-timestamp"] = String(Date.now() + direction * (OPEN_SIGN_WINDOW_MS + 1000))
    signRequest(req)
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
    expect(prisma.openApiApp.findUnique).not.toHaveBeenCalled()
  })

  it("不存在的服务统一 401；停用服务需先通过签名才返回 403", async () => {
    prisma.openApiApp.findUnique.mockResolvedValue(null)
    await expect(guard.canActivate(ctxOf(validReq()))).rejects.toBeInstanceOf(UnauthorizedException)
    prisma.openApiApp.findUnique.mockResolvedValue({ ...APP, status: "DISABLED" })
    const unsigned = validReq()
    unsigned.headers["x-sign"] = "0".repeat(64)
    await expect(guard.canActivate(ctxOf(unsigned))).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(guard.canActivate(ctxOf(validReq()))).rejects.toBeInstanceOf(ForbiddenException)
    await expect(guard.canActivate(ctxOf(validReq()))).rejects.toMatchObject({
      response: { code: "OPEN_APP_DISABLED", message: "接入方已停用" },
    })
  })
})
