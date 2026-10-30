import { Global, Injectable, Module, type NestMiddleware } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"
import { PrismaModule } from "../prisma/prisma.module"
import { textAuditContext } from "./text-audit"
import { isTextGenerationRequest } from "./text-audit-routes"
import { TextAuditService } from "./text-audit.service"

@Injectable()
export class AigcAuditMiddleware implements NestMiddleware {
  constructor(private readonly audit: TextAuditService) {}
  use(request: Request, _response: Response, next: NextFunction) {
    const context = this.audit.context(
      () => (request as Request & { user?: { id?: number } }).user?.id ?? null,
      () => request.body as unknown
    )
    context.rejectedInput = () =>
      isTextGenerationRequest(request.method, request.path, request.body as unknown)
    textAuditContext.run(context, next)
  }
}

@Global()
@Module({
  imports: [PrismaModule],
  providers: [TextAuditService, AigcAuditMiddleware],
  exports: [TextAuditService, AigcAuditMiddleware],
})
export class AigcModule {}
