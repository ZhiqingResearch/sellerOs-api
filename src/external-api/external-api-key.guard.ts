import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { Request } from "express"
import { timingSafeEqual } from "node:crypto"

@Injectable()
export class ExternalApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    // 外部模板接口使用独立密钥，不复用 JWT 或其他内部回调密钥。
    const expected = this.config.get<string>("EXTERNAL_IMAGE_TEMPLATE_API_KEY", "").trim()
    if (!expected) throw new ServiceUnavailableException("外部模板接口密钥未配置")

    const request = context.switchToHttp().getRequest<Request>()
    const actual = request.get("x-api-key") ?? ""
    const actualBuffer = Buffer.from(actual, "utf8")
    const expectedBuffer = Buffer.from(expected, "utf8")

    // 先比较字节长度，再使用恒定时间比较，避免直接字符串比较带来的时序差异。
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException("X-API-Key 不正确")
    }

    return true
  }
}
