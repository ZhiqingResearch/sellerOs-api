import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common"
import { createHash, createHmac } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { OPEN_SIGN_WINDOW_MS, OpenApiAuthGuard } from "./open-api-auth.guard"

/** 按签名规则构造合法签名（与 guard 同一算法） */
function signOf(appSecret: string, appId: string, timestamp: string, nonce: string, body: string) {
  const bodyHash = createHash("sha256").update(body).digest("hex")
  return createHmac("sha256", appSecret)
    .update(`${appId}\n${timestamp}\n${nonce}\n${bodyHash}`)
    .digest("hex")
}

function ctxOf(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext
}

describe("OpenApiAuthGuard", () => {
  const APP = {
    id: 1,
    appId: "app-1",
    appSecret: "secret-1",
    name: "ERP 系统",
    status: "ACTIVE",
    perCallMaxCny: null,
  }
  let guard: OpenApiAuthGuard
  let prisma: { openApiApp: { findUnique: jest.Mock } }

  beforeEach(() => {
    prisma = { openApiApp: { findUnique: jest.fn().mockResolvedValue(APP) } }
    guard = new OpenApiAuthGuard(prisma as unknown as PrismaService)
  })

  const validReq = (over: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ phone: "13800001234", costCny: 1 })
    const timestamp = String(Date.now())
    const nonce = "n1"
    return {
      headers: {
        "x-app-id": "app-1",
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-sign": signOf("secret-1", "app-1", timestamp, nonce, body),
      },
      rawBody: Buffer.from(body),
      ...over,
    }
  }

  it("合法签名放行并把 app 挂到 req", async () => {
    const req = validReq()
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true)
    expect((req as { openApiApp?: unknown }).openApiApp).toBe(APP)
  })

  it("GET 无请求体：bodyHash 按空串计算", async () => {
    const timestamp = String(Date.now())
    const nonce = "n2"
    const req = {
      headers: {
        "x-app-id": "app-1",
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-sign": signOf("secret-1", "app-1", timestamp, nonce, ""),
      },
      // 无 rawBody
    }
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true)
  })

  it("签名头缺失 → 401", async () => {
    await expect(guard.canActivate(ctxOf({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException
    )
  })

  it("签名错误（body 被篡改）→ 401", async () => {
    const req = validReq()
    ;(req as { rawBody: Buffer }).rawBody = Buffer.from(JSON.stringify({ costCny: 0.01 }))
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it("时间戳超窗（±5 分钟）→ 401", async () => {
    const old = String(Date.now() - OPEN_SIGN_WINDOW_MS - 1000)
    const body = ""
    const req = {
      headers: {
        "x-app-id": "app-1",
        "x-timestamp": old,
        "x-nonce": "n3",
        "x-sign": signOf("secret-1", "app-1", old, "n3", body),
      },
    }
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException)
    expect(prisma.openApiApp.findUnique).not.toHaveBeenCalled() // 时间窗先拒，不查库
  })

  it("接入方不存在 → 401；已停用 → 403", async () => {
    prisma.openApiApp.findUnique.mockResolvedValue(null)
    await expect(guard.canActivate(ctxOf(validReq()))).rejects.toBeInstanceOf(UnauthorizedException)

    prisma.openApiApp.findUnique.mockResolvedValue({ ...APP, status: "DISABLED" })
    await expect(guard.canActivate(ctxOf(validReq()))).rejects.toBeInstanceOf(ForbiddenException)
  })
})
