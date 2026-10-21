import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common"
import type { Request } from "express"
import type { AuthedRequest } from "../material-pool/dto/common.dto"

/**
 * 内部生成代理接口鉴权：校验 X-Internal-Token 请求头与 INTERNAL_GENERATION_TOKEN
 * 环境变量一致（建议叠加 IP 白名单）；供 VidFlowOS 服务间调用，不走用户 JWT。
 */
@Injectable()
export class InternalGenerationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest & Request>()
    const expected = process.env.INTERNAL_GENERATION_TOKEN?.trim() ?? ""
    if (!expected) {
      throw new ServiceUnavailableException("未配置 INTERNAL_GENERATION_TOKEN，内部生成接口不可用")
    }
    const provided = request.headers["x-internal-token"]
    const token = Array.isArray(provided) ? provided[0] : provided
    if (token !== expected) {
      throw new ServiceUnavailableException("内部生成接口鉴权失败")
    }
    return true
  }
}
