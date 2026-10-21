import {
  BadRequestException,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  NotFoundException,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileFieldsInterceptor } from "@nestjs/platform-express"
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger"
import type { Request } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PrismaService } from "../prisma/prisma.service"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { LocalRedrawForm } from "./local-redraw.dto"
import {
  LocalRedrawService,
  parseLocalRedrawForm,
  type LocalRedrawFiles,
} from "./local-redraw.service"

@Injectable()
export class LocalRedrawAuthGuard extends JwtAuthGuard {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>()
    return req.headers["x-internal-token"] !== undefined
      ? new InternalGenerationGuard().canActivate(context)
      : super.canActivate(context)
  }
}

@ApiTags("局部重绘")
@ApiExtraModels(LocalRedrawForm)
@ApiBearerAuth()
@Controller("image-generation")
@UseGuards(LocalRedrawAuthGuard)
export class LocalRedrawController {
  constructor(
    private readonly redraw: LocalRedrawService,
    private readonly prisma: PrismaService
  ) {}

  @Post("local-redraw")
  @HttpCode(200)
  @ApiOperation({ summary: "统一局部重绘：通用、电商、工厂、人像和未归档改图" })
  @ApiConsumes("application/json", "multipart/form-data")
  @ApiBody({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(LocalRedrawForm) },
        {
          type: "object",
          required: ["form"],
          properties: {
            form: {
              type: "string",
              description: "JSON：prompt、count、projectId、sourceImageId、mainImageUrls",
            },
            main: { type: "string", format: "binary" },
            refs: { type: "array", items: { type: "string", format: "binary" } },
          },
        },
      ],
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "main", maxCount: 1 },
        { name: "refs", maxCount: 10 },
      ],
      { limits: { fileSize: 50 * 1024 * 1024, files: 11 } }
    )
  )
  async create(@Req() req: Request, @UploadedFiles() files: LocalRedrawFiles) {
    const body = (req.body ?? {}) as Record<string, unknown>
    const internal = req.headers["x-internal-token"] !== undefined
    let userId: number
    if (internal) {
      if (typeof body.phone !== "string" || !body.phone.trim())
        throw new BadRequestException("phone 不能为空")
      const user = await this.prisma.user.findUnique({
        where: { phone: body.phone.trim() },
        select: { id: true },
      })
      if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND" })
      userId = user.id
    } else userId = (req.user as { id: number }).id
    const raw =
      body.form ??
      (internal
        ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "phone"))
        : body)
    return this.redraw.create(
      parseLocalRedrawForm(raw),
      files ?? {},
      userId,
      internal ? "vidflowos" : "platform"
    )
  }
}
