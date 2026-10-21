import { Injectable, ServiceUnavailableException } from "@nestjs/common"
import {
  PortraitImageGenerateInput,
  PortraitImageGenerateResult,
  PortraitImageGenerator,
} from "./portrait-image-generator"

/** 当前默认实现：保留调用位置，但在真实模型接入前不制造悬挂任务。 */
@Injectable()
export class UnconfiguredPortraitImageGenerator implements PortraitImageGenerator {
  isAvailable() {
    return false
  }

  submit(input: PortraitImageGenerateInput): Promise<PortraitImageGenerateResult> {
    void input
    return Promise.reject(new ServiceUnavailableException("人像生图能力尚未接入"))
  }
}
