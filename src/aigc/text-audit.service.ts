import { Injectable, Logger } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { PrismaService } from "../prisma/prisma.service"
import { setBackgroundAuditContext, type TextAuditContext } from "./text-audit"

@Injectable()
export class TextAuditService {
  private readonly logger = new Logger("AigcTextAudit")

  constructor(private readonly prisma: PrismaService) {
    setBackgroundAuditContext(userId =>
      this.context(
        () => userId,
        () => null
      )
    )
  }

  context(userId: () => number | null, question: () => unknown): TextAuditContext {
    return {
      requestId: randomUUID(),
      userId,
      question,
      review: "NOT_CHECKED",
      displayName: async id => {
        const model = await this.prisma.aiGatewayModel
          .findFirst({
            where: { publicId: id },
            select: { displayName: true },
            orderBy: { id: "asc" },
          })
          .catch(() => null)
        return model?.displayName?.trim() || null
      },
      write: entry => {
        this.logger.log({ event: "aigc.text", ...entry })
        return Promise.resolve()
      },
    }
  }
}
