import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common"
import { Request, Response } from "express"
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston"
import { Logger as WinstonLogger } from "winston"
import { isKeybSensitiveUrl, keybSafeLogUrl } from "../utils/keyb-log-url"

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: WinstonLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()
    const keybSensitive = isKeybSensitiveUrl(request.url)

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR
    let message: string | string[] = "服务器内部错误"
    const details: Record<string, unknown> = {}

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const res = exception.getResponse()
      if (typeof res === "string") {
        message = res
      } else {
        const body = res as Record<string, unknown>
        message = isMessage(body.message) ? body.message : exception.message
        if (typeof body.code === "string") details.code = body.code
        if (isRecord(body.details)) details.details = body.details
      }
    } else if (isStatusError(exception)) {
      status = exception.status
      message = typeof exception.message === "string" ? exception.message : message
    }

    if (keybSensitive) {
      // JSON parser errors can include raw request excerpts. Never log those on credential routes.
      if (status === 400 && /json/i.test(Array.isArray(message) ? message.join(" ") : message)) {
        message = "请求 JSON 格式不正确"
      }
      const redact = (text: string) => text.replace(/(?:zk-|sk_)[A-Za-z0-9_-]+/gi, "[凭证已隐藏]")
      message = Array.isArray(message) ? message.map(redact) : redact(message)
    }

    const errorResponse = {
      statusCode: status,
      ...details,
      message,
      timestamp: new Date().toISOString(),
    }

    // 5xx 错误记录完整堆栈，4xx 记录 warn 级别
    if (status >= 500) {
      const logMessage = keybSensitive
        ? Array.isArray(message)
          ? message.join(", ")
          : message
        : exception instanceof Error
          ? exception.message
          : String(exception)
      this.logger.error(
        `${request.method} ${keybSafeLogUrl(request.url)} ${status} - ${logMessage}`,
        {
          context: "ExceptionFilter",
          stack: !keybSensitive && exception instanceof Error ? exception.stack : undefined,
        }
      )
    } else if (status >= 400) {
      this.logger.warn(
        `${request.method} ${keybSafeLogUrl(request.url)} ${status} - ${Array.isArray(message) ? message.join(", ") : message}`,
        { context: "ExceptionFilter" }
      )
    }

    response.status(status).json(errorResponse)
  }
}

function isMessage(value: unknown): value is string | string[] {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every(item => typeof item === "string"))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStatusError(value: unknown): value is { status: number; message?: unknown } {
  return isRecord(value) && typeof value.status === "number"
}
