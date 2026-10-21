import { ConfigService } from "@nestjs/config"
import { WinstonModuleAsyncOptions, WinstonModuleOptions, utilities } from "nest-winston"
import * as winston from "winston"
import DailyRotateFile from "winston-daily-rotate-file"

export const winstonAsyncConfig: WinstonModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService): WinstonModuleOptions => {
    const isProd = configService.get("NODE_ENV") === "production"

    const transports: WinstonModuleOptions["transports"] = [
      // error 日志文件：保留 14 天，单文件最大 10MB，自动压缩
      new DailyRotateFile({
        level: "error",
        dirname: "logs",
        filename: "error-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "10m",
        maxFiles: "14d",
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      }),
      // warn 日志文件
      new DailyRotateFile({
        level: "warn",
        dirname: "logs",
        filename: "warn-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "10m",
        maxFiles: "14d",
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      }),
      // 控制台：开发环境彩色可读，生产环境 JSON
      new winston.transports.Console({
        level: "debug",
        format: winston.format.combine(
          winston.format.timestamp(),
          isProd
            ? winston.format.json()
            : utilities.format.nestLike("AI-Sourcing", { prettyPrint: true, colors: true })
        ),
      }),
    ]

    return { transports }
  },
}
