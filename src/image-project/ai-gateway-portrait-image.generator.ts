import { Injectable } from "@nestjs/common"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import type {
  PortraitImageGenerateInput,
  PortraitImageGenerateResult,
  PortraitImageGenerator,
} from "./portrait-image-generator"
import { buildPortraitImageTaskRequest } from "./portrait-image-generator"

@Injectable()
export class AiGatewayPortraitImageGenerator implements PortraitImageGenerator {
  constructor(private readonly gateway: AiGatewayProvider) {}

  isAvailable(): boolean {
    return this.gateway.isConfigured()
  }

  async submit(input: PortraitImageGenerateInput): Promise<PortraitImageGenerateResult> {
    const task = await this.gateway.createImageTask(
      buildPortraitImageTaskRequest(input),
      input.idempotencyKey
    )
    return { jobId: task.id }
  }
}
