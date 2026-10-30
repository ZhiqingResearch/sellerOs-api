import { ArgumentsHost, BadRequestException, Catch, type ExceptionFilter } from "@nestjs/common"
import type { Response } from "express"

const MULTER_ERRORS = new Set([
  "Too many parts",
  "Too many files",
  "Too many fields",
  "Field name too long",
  "Field value too long",
  "Field name missing",
  "Unexpected field",
])

@Catch(BadRequestException)
export class InvalidMultipartFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const response = exception.getResponse()
    const body =
      typeof response === "string" ? { message: response } : (response as Record<string, unknown>)
    const message =
      typeof body.message === "string"
        ? body.message
        : Array.isArray(body.message) && body.message.every(item => typeof item === "string")
          ? body.message.join(", ")
          : exception.message
    // Nest将Multer/Busboy错误转换为BadRequest；审核等业务400必须保留真实原因。
    const malformed =
      message.startsWith("Multipart: ") || MULTER_ERRORS.has(message.split(" - ")[0])
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(400)
      .json({
        error: malformed ? "Invalid multipart/form-data body" : message,
        ...(!malformed && typeof body.code === "string" ? { code: body.code } : {}),
      })
  }
}
