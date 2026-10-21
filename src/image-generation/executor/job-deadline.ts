// src/image-generation/executor/job-deadline.ts
//
// t2i/i2i Job 墙钟 deadline 单一来源:对账收敛(ReconciliationService)与
// 执行器 T8 重投(ImageGenItemRunnerService)共用。独立小文件,避免两个
// 服务互相 import 形成循环依赖(Nest DI 元数据在环上会拿到 undefined)。

const T2I_DEADLINE_MS = Number(process.env.IMAGE_GEN_T2I_DEADLINE_MS) || 10 * 60_000;
const I2I_DEADLINE_MS = Number(process.env.IMAGE_GEN_I2I_DEADLINE_MS) || 15 * 60_000;

export function jobDeadlineMs(kind: string): number {
  return kind === "IMAGE_TO_IMAGE" ? I2I_DEADLINE_MS : T2I_DEADLINE_MS;
}
