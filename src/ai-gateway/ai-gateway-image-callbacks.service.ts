// src/ai-gateway/ai-gateway-image-callbacks.service.ts
//
// 网关 image.task 终态回调的进程内分发枢纽(2026-09-10,通用生图管线
// 轮询改 callback):
//   - 通用生图管线(src/image-generation)的网关适配器提交任务后注册
//     waiter,等本枢纽把 webhook 收到的终态任务直接递给它 —— 不落库、
//     不做业务结算(执行器的 CAS/归一/计费流程原样保留在 provider 返回
//     之后的既有路径里);
//   - image-project(人像/AI拆图)继续走 webhook service 的 applyImageTask
//     落库+扣费路径,两者按「hub 是否有 waiter」分流,互不干扰;
//   - 近期终态缓存(60s TTL)兜「快任务在 createImageTask 响应与 waiter
//     注册之间回调先到」的竞态:先到的终态暂存,waitForTerminal 立即取走。
//
// 单实例语义:waiter 是进程内的。多副本部署时回调落在任一副本,未命中
// waiter 的副本缓存后返回未处理 —— 依赖各副本自己的稀疏轮询兜底收敛
// (gateway-image.provider 的 backstop),不会丢任务。回调 URL 指向的
// 副本与提交副本不同时,退化为纯 backstop 轮询模式,行为正确只是慢。

import { Injectable, Logger } from "@nestjs/common";
import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk";

const RECENT_TTL_MS = 60_000;

/** 通用生图管线网关任务幂等键前缀(单一来源):image-generation 三个执行器
 *  提交网关任务统一用它拼幂等键(回显在回调事件的 request_id 上)。webhook
 *  据此识别「waiter 已不在的管线任务」(进程重启/多副本/晚到回调),安静
 *  吞掉而不是落 GenerationTask 查询(查不到会 503,引发网关重试风暴)。 */
export const IMAGE_PIPELINE_IDEMPOTENCY_PREFIX = "imggen:";

/** 解析管线幂等键 `imggen:{owner}:{child}:{attempt}`(单一来源,webhook 审计落库
 *  与执行器 flush 聚合共用)。owner:generate 管线 = 数字 GenerationTask.id,
 *  t2i/i2i = UUID jobId;child = GeneratedImage.id / ImageGenItem.id;attempt 为
 *  0 起的重试轮次。形状不符返回 null,调用方各自兜底。 */
export function parseImagePipelineIdempotencyKey(
  requestId: string,
): { owner: string; childId: number; attemptNo: number } | null {
  if (!requestId.startsWith(IMAGE_PIPELINE_IDEMPOTENCY_PREFIX)) return null;
  const parts = requestId.slice(IMAGE_PIPELINE_IDEMPOTENCY_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [owner, child, attempt] = parts;
  if (!owner || !/^\d+$/.test(child) || !/^\d+$/.test(attempt)) return null;
  return { owner, childId: Number(child), attemptNo: Number(attempt) };
}

@Injectable()
export class AiGatewayImageCallbacksService {
  private readonly logger = new Logger(AiGatewayImageCallbacksService.name);
  private readonly waiters = new Map<string, (task: ImageTask) => void>();
  private readonly recent = new Map<string, { task: ImageTask; expiresAt: number }>();

  /** 注册等待:返回的 Promise 在终态回调到达(或命中近期缓存)时 resolve。
   *  只 resolve 终态(queued/running 事件被 notify 过滤),不会 reject。 */
  waitForTerminal(taskId: string): Promise<ImageTask> {
    this.sweepRecent();
    const cached = this.recent.get(taskId);
    if (cached) {
      this.recent.delete(taskId);
      return Promise.resolve(cached.task);
    }
    return new Promise<ImageTask>((resolve) => {
      this.waiters.set(taskId, resolve);
    });
  }

  /** 释放 waiter(provider 经 backstop/超时自行了断时调用),防泄漏。 */
  release(taskId: string): void {
    this.waiters.delete(taskId);
  }

  /** webhook 入口:分发终态 image.task。返回 true = 存在待处理 waiter
   *  (或非终态事件但任务确属本管线),webhook 据此跳过 GenerationTask
   *  兜底路径;false = 与本管线无关,走 applyImageTask。 */
  notify(task: ImageTask): boolean {
    const hasWaiter = this.waiters.has(task.id);
    if (task.status === "queued" || task.status === "running") {
      // 非终态事件:对 waiter 无信息量(只 resolve 终态);有 waiter 即视为
      // 本管线任务,拦下避免误走 GenerationTask 路径。
      return hasWaiter;
    }
    const resolve = this.waiters.get(task.id);
    if (resolve) {
      this.waiters.delete(task.id);
      resolve(task);
      return true;
    }
    // 无 waiter:快任务竞态(createImageTask 响应前回调已到 / 提交副本与
    // 回调副本不同)——暂存供 waitForTerminal 即取,同时让 webhook 走兜底。
    this.sweepRecent();
    this.recent.set(task.id, { task, expiresAt: Date.now() + RECENT_TTL_MS });
    this.logger.debug(
      `image.task terminal cached (no waiter): task=${task.id} status=${task.status}`,
    );
    return false;
  }

  private sweepRecent(): void {
    const now = Date.now();
    for (const [id, entry] of this.recent) {
      if (entry.expiresAt < now) this.recent.delete(id);
    }
  }
}
