import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Inject } from "@nestjs/common"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { Response } from "express"
import { WINSTON_MODULE_PROVIDER } from "nest-winston"
import { Logger as WinstonLogger } from "winston"

const ERROR_CODE_MAP: Record<string, { status: number; message: string }> = {
  P2000: { status: HttpStatus.BAD_REQUEST, message: "字段值超出允许范围" },
  P2001: { status: HttpStatus.NOT_FOUND, message: "目标记录不存在" },
  P2002: { status: HttpStatus.CONFLICT, message: "唯一约束冲突，数据已存在" },
  P2003: { status: HttpStatus.BAD_REQUEST, message: "外键约束失败" },
  P2005: { status: HttpStatus.BAD_REQUEST, message: "字段值无效" },
  P2011: { status: HttpStatus.BAD_REQUEST, message: "不能为空" },
  P2012: { status: HttpStatus.BAD_REQUEST, message: "缺少必需字段" },
  P2014: { status: HttpStatus.CONFLICT, message: "关联关系冲突" },
  P2015: { status: HttpStatus.NOT_FOUND, message: "关联记录未找到" },
  P2024: { status: HttpStatus.REQUEST_TIMEOUT, message: "数据库连接超时" },
  P2025: { status: HttpStatus.NOT_FOUND, message: "目标记录不存在" },
}

@Catch(PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: WinstonLogger) {}

  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()

    const errorConfig = ERROR_CODE_MAP[exception.code] ?? {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "数据库操作异常",
    }

    this.logger.error(`Prisma error [${exception.code}]: ${exception.message}`, {
      context: "PrismaExceptionFilter",
      code: exception.code,
      meta: exception.meta,
      stack: exception.stack,
    })

    response.status(errorConfig.status).json({
      statusCode: errorConfig.status,
      message: errorConfig.message,
      timestamp: new Date().toISOString(),
    })
  }
}
