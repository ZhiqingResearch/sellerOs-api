import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"
import { INTERNAL_LISTING_AI_MODELS } from "../listing-ai.models"

interface ListingModelRequest {
  user?: { id: number }
  body?: {
    model?: unknown
    main?: { model?: unknown }
    longTitle?: { model?: unknown }
    autoScore?: { model?: unknown }
  }
}

@Injectable()
export class ListingModelSelectionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ListingModelRequest>()
    const body = request.body
    const models = [body?.model, body?.main?.model, body?.longTitle?.model, body?.autoScore?.model]
    const hasInternalModel = models.some(model =>
      INTERNAL_LISTING_AI_MODELS.some(value => value === model)
    )
    if (!hasInternalModel) return true

    const role =
      request.user &&
      (await this.prisma.userRole.findFirst({
        where: {
          userId: request.user.id,
          role: { name: { in: ["运营专员（内部）", "运营专员(内部)"] } },
        },
        select: { roleId: true },
      }))
    if (!role) throw new ForbiddenException("仅运营专员（内部）可选择该 Listing 模型")
    return true
  }
}
