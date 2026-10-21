import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { OpenApiApp } from "@prisma/client"
import { createHash, createHmac, timingSafeEqual } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { OPEN_API_KEYB_SIGNATURE } from "./open-api-keyb-signature.decorator"

/** 签名时间戳允许的最大偏差（防重放窗口）：±5 分钟 */
export const OPEN_SIGN_WINDOW_MS = 5 * 60 * 1000

interface OpenRequest {
  headers: Record<string, string | string[] | undefined>
  rawHeaders?: string[]
  method?: string
  originalUrl?: string
  rawBody?: Buffer
  openApiApp?: OpenApiApp
  openApiKeyB?: string
}

/** 仅在 OpenApiAuthGuard 的 KeyB v2 分支成功后使用。 */
export interface KeybOpenRequest extends OpenRequest {
  openApiApp: OpenApiApp
  openApiKeyB: string
}

/**
 * 对外开放接口鉴权（仅 /open/*）：AppId + HMAC-SHA256 签名。
 * 请求头：x-app-id / x-timestamp（毫秒，±5 分钟窗口）/ x-nonce / x-sign。
 * 签名规则：sign = HMAC_SHA256(appSecret, appId + "\n" + timestamp + "\n" + nonce + "\n" + sha256Hex(rawBody))
 * （GET 无请求体时 bodyHash = sha256("")）。窗口内重放由扣费接口的 requestId 幂等兜底。
 */
@Injectable()
export class OpenApiAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector = new Reflector()
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OpenRequest>()
    if (
      this.reflector.getAllAndOverride<boolean>(OPEN_API_KEYB_SIGNATURE, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    ) {
      return this.authenticateKeyb(req)
    }
    const header = (k: string) => {
      const v = req.headers[k]
      return Array.isArray(v) ? v[0] : v
    }
    const appId = header("x-app-id")
    const timestamp = header("x-timestamp")
    const nonce = header("x-nonce")
    const sign = header("x-sign")
    if (!appId || !timestamp || !nonce || !sign) {
      throw new UnauthorizedException("缺少签名请求头（x-app-id / x-timestamp / x-nonce / x-sign）")
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > OPEN_SIGN_WINDOW_MS) {
      throw new UnauthorizedException("签名时间戳过期或非法")
    }
    const app = await this.prisma.openApiApp.findUnique({ where: { appId } })
    if (!app) throw new UnauthorizedException("接入方不存在")
    if (app.status !== "ACTIVE") throw new ForbiddenException("接入方已停用")

    const bodyHash = createHash("sha256")
      .update(req.rawBody ?? "")
      .digest("hex")
    const expected = createHmac("sha256", app.appSecret)
      .update(`${appId}\n${timestamp}\n${nonce}\n${bodyHash}`)
      .digest("hex")
    const a = Buffer.from(expected)
    const b = Buffer.from(sign)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("签名校验失败")
    }

    req.openApiApp = app
    return true
  }

  /**
   * v2 规范：HMAC_SHA256(appSecret, ["v2", METHOD, originalUrl, appId, timestamp,
   * nonce, sha256Hex(KeyB), sha256Hex(rawBody)].join("\n"))，输出小写 hex。
   * originalUrl 保留 /api 前缀，当前入口不接受 query；rawBody 必须为 JSON 原始字节。
   * nonce 不单独落库防重放，业务重试继续由稳定 requestId 和既有扣费内核防重。
   */
  private async authenticateKeyb(req: OpenRequest): Promise<boolean> {
    const invalid = () =>
      new UnauthorizedException({
        code: "OPEN_AUTH_INVALID",
        message: "服务签名或用户凭证格式无效",
      })
    const names = [
      "authorization",
      "x-sign-version",
      "x-app-id",
      "x-timestamp",
      "x-nonce",
      "x-sign",
      "content-type",
    ]
    // Node 可能合并或忽略重复头；原始头可用时，拒绝所有鉴权相关重复头。
    const seen = new Set<string>()
    for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
      const name = req.rawHeaders![i].toLowerCase()
      if (!names.includes(name)) continue
      if (seen.has(name)) throw invalid()
      seen.add(name)
    }
    const header = (name: string): string => {
      const value = req.headers[name]
      if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw invalid()
      return value
    }
    const version = header("x-sign-version")
    const appId = header("x-app-id")
    const timestamp = header("x-timestamp")
    const nonce = header("x-nonce")
    const sign = header("x-sign")
    const authorization = header("authorization")
    const contentType = header("content-type").split(";")[0].trim().toLowerCase()
    const keyMatch = /^Bearer ((?:zk-|sk_)[A-Za-z0-9_-]{1,509})$/i.exec(authorization)
    const method = req.method
    const path = req.originalUrl
    if (
      version !== "v2" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(appId) ||
      !/^\d{10,16}$/.test(timestamp) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(nonce) ||
      !/^[0-9a-f]{64}$/.test(sign) ||
      !keyMatch ||
      contentType !== "application/json" ||
      !Buffer.isBuffer(req.rawBody) ||
      typeof method !== "string" ||
      !/^[A-Za-z]+$/.test(method) ||
      typeof path !== "string" ||
      !path.startsWith("/") ||
      /[\r\n?#]/.test(path)
    ) {
      throw invalid()
    }
    const ts = Number(timestamp)
    if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > OPEN_SIGN_WINDOW_MS) {
      throw invalid()
    }

    const app = await this.prisma.openApiApp.findUnique({ where: { appId } })
    if (!app) throw invalid()
    const keyB = keyMatch[1]
    const keyHash = createHash("sha256").update(keyB).digest("hex")
    const bodyHash = createHash("sha256").update(req.rawBody).digest("hex")
    const expected = createHmac("sha256", app.appSecret)
      .update(
        ["v2", method.toUpperCase(), path, appId, timestamp, nonce, keyHash, bodyHash].join("\n")
      )
      .digest("hex")
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sign, "hex"))) {
      throw invalid()
    }
    if (app.status !== "ACTIVE") {
      throw new ForbiddenException({ code: "OPEN_APP_DISABLED", message: "接入方已停用" })
    }

    req.openApiApp = app
    // 避免通用对象枚举/序列化意外把用户凭证明文写进日志。
    Object.defineProperty(req, "openApiKeyB", { value: keyB, configurable: true })
    return true
  }
}
