// src/image-generation/executor/dispatch-queue.service.ts
//
// 进程内并发调度(信号量),行为对齐 Next 路由原生的 IMAGE_GEN_MAX_CONCURRENCY
// 信号量(默认 6)。队列本身是内存的、可丢失——执行真相在 DB(租约 + CAS),
// 丢失由 ReconciliationService 兜底重投。

import { Injectable, Logger } from "@nestjs/common";

const IMAGE_GEN_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.IMAGE_GEN_MAX_CONCURRENCY) || 6,
);

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      if (this.active < this.max) {
        this.active++;
        resolve();
      } else {
        this.waiters.push(() => {
          this.active++;
          resolve();
        });
      }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

@Injectable()
export class DispatchQueueService {
  private readonly logger = new Logger(DispatchQueueService.name);
  private readonly semaphore = new Semaphore(IMAGE_GEN_MAX_CONCURRENCY);

  /** Fire-and-forget:占一个并发槽执行 fn,异常只记日志不上抛。 */
  enqueue(task: () => Promise<void>): void {
    void (async () => {
      const release = await this.semaphore.acquire();
      try {
        await task();
      } catch (err) {
        this.logger.error(
          `[dispatch] task failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        release();
      }
    })();
  }
}
