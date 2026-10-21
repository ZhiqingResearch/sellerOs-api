import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  PipeTransform,
} from "@nestjs/common"
import type { Request } from "express"

export const EXTERNAL_USER_PHONE_HEADER = "X-User-Phone"

export function readExternalUserPhone(context: ExecutionContext): string | undefined {
  return context.switchToHttp().getRequest<Request>().get(EXTERNAL_USER_PHONE_HEADER)
}

/** 从外部接口请求头读取目标用户手机号，业务控制器无需直接依赖 Express Request。 */
export const ExternalUserPhone = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => readExternalUserPhone(context)
)

@Injectable()
export class ExternalUserPhonePipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== "string") {
      throw new BadRequestException(`${EXTERNAL_USER_PHONE_HEADER} 请求头不能为空`)
    }

    const phone = value.trim()
    if (!phone) throw new BadRequestException(`${EXTERNAL_USER_PHONE_HEADER} 请求头不能为空`)
    if (phone.length > 20) {
      throw new BadRequestException(`${EXTERNAL_USER_PHONE_HEADER} 长度不能超过 20 个字符`)
    }
    return phone
  }
}
