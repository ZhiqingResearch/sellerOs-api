import { NestFactory } from "@nestjs/core"
import { NestExpressApplication } from "@nestjs/platform-express"
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger"
import { WINSTON_MODULE_NEST_PROVIDER, WINSTON_MODULE_PROVIDER } from "nest-winston"
import { Logger as WinstonLogger } from "winston"
import { AppModule } from "./app.module"
import { AllExceptionsFilter } from "./common/filters/http-exception.filter"
import { PrismaExceptionFilter } from "./common/filters/prisma-exception.filter"

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  })

  // Stripe webhook 验签需要原始请求体：json 解析前把 buf 挂到 req.rawBody（billing/webhooks/stripe 使用）
  app.useBodyParser("json", {
    limit: "5mb",
    verify: (req: { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      req.rawBody = buf
    },
  })
  app.useBodyParser("urlencoded", { limit: "5mb", extended: true })

  // 使用 Winston 替换 NestJS 内置日志
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER))
  // 启用优雅关闭，确保进程退出时清理数据库连接
  app.enableShutdownHooks()

  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
    // 前端跨域 fetch 读下载文件名（asin-audit/reviews/download 的 Content-Disposition）
    exposedHeaders: ["Content-Disposition"],
  })
  app.setGlobalPrefix("api")
  const winstonLogger = app.get<WinstonLogger>(WINSTON_MODULE_PROVIDER)
  // AllExceptionsFilter 兜底，PrismaExceptionFilter 优先捕获 Prisma 错误
  app.useGlobalFilters(
    new AllExceptionsFilter(winstonLogger),
    new PrismaExceptionFilter(winstonLogger)
  )

  const config = new DocumentBuilder()
    .setTitle("AI Sourcing Platform API")
    .setDescription("AI 寻源平台接口文档")
    .setVersion("1.0")
    .addBearerAuth()
    .build()
  const document = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup("api-docs", app, document)

  const port = process.env.PORT ?? 8000
  await app.listen(port)

  const logger = app.get<WinstonLogger>(WINSTON_MODULE_PROVIDER)
  logger.info(`Application is running on port ${port}`, { context: "Bootstrap" })
  logger.info(`Swagger docs: http://localhost:${port}/api-docs`, { context: "Bootstrap" })
}
void bootstrap()
