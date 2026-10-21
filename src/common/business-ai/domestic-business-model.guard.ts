import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common"
import { DomesticBusinessModels } from "./domestic-business-models"

/** 在原有权限守卫之外，开流、采集数据和任务入队前增加模型校验。 */
@Injectable()
export class DomesticBusinessModelGuard implements CanActivate {
  constructor(private readonly models: DomesticBusinessModels) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { body } = context.switchToHttp().getRequest<{ body?: Record<string, unknown> }>()
    if (!body || typeof body !== "object") return true
    const selected = new Set<unknown>()
    if (Object.hasOwn(body, "model")) selected.add(body.model)
    for (const key of ["main", "longTitle", "autoScore"]) {
      const step = body[key]
      if (step && typeof step === "object" && !Array.isArray(step)) {
        selected.add((step as Record<string, unknown>).model)
      }
    }
    for (const model of selected) await this.models.assertEnabled(model)
    return true
  }
}
