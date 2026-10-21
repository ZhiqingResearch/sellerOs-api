import { Inject, Injectable, NestMiddleware } from "@nestjs/common"
import { NextFunction, Request, Response } from "express"
import { WINSTON_MODULE_PROVIDER } from "nest-winston"
import { Logger } from "winston"
import { isKeybSensitiveUrl, keybSafeLogUrl } from "../utils/keyb-log-url"

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger) {}

  use(req: Request, res: Response, next: NextFunction) {
    const { method, ip } = req
    const originalUrl = keybSafeLogUrl(req.originalUrl)
    const userAgent = isKeybSensitiveUrl(req.originalUrl) ? "" : (req.get("user-agent") ?? "")
    const start = Date.now()

    res.on("finish", () => {
      const duration = Date.now() - start
      const { statusCode } = res

      const logData = {
        context: "HTTP",
        method,
        url: originalUrl,
        statusCode,
        duration: `${duration}ms`,
        ip,
        userAgent,
      }

      if (statusCode >= 500) {
        this.logger.error(`${method} ${originalUrl} ${statusCode} ${duration}ms`, logData)
      } else if (statusCode >= 400) {
        this.logger.warn(`${method} ${originalUrl} ${statusCode} ${duration}ms`, logData)
      } else {
        this.logger.info(`${method} ${originalUrl} ${statusCode} ${duration}ms`, logData)
      }
    })

    next()
  }
}
