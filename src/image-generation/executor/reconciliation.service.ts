// src/image-generation/executor/reconciliation.service.ts
//
// 对账与清理(设计 §5.3):
//   - 启动时 + 每分钟 Cron:
//       1) 租约过期的 RUNNING item 重投执行(新 attempt);
//       2) 超过 deadline 仍未终态的 item 收敛 FAILED + Job FAILED(消息与
//          前端超时文案一致;deadline 默认大于前端 deadline,保证前端
//          自己的超时先生效,不产生状态倒挂);
//       3) 删除超过审计保留窗口的 ImageGenJob(级联删 item;默认永久保留,
//          IMAGE_GEN_JOB_RECORD_RETENTION_DAYS 可收紧)。快照轮询的 30 分钟
//          404 契约由 GET 读路径按 expiresAt 判定,与清理无关。
//   - 主生图(generate,GenerationTask/GeneratedImage)同范式扩展:
//       4) 租约过期的 GENERATING 图重投执行(任务仍 GENERATING 才有意义);
//       5) 超 deadlineAt 仍未终态的任务收敛:任务 TIMEOUT、图 FAILED
//          (errorMessage 照源 = 前端 10 分钟超时的 PATCH 载荷文案)。

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { IMAGE_CREATIVE_BUSINESS_TYPE } from "../../chetaidou/chetaidou.constants";
import { PrismaService } from "../../prisma/prisma.service";
import { DispatchQueueService } from "./dispatch-queue.service";
import { GenerationTaskRunnerService, GENERATION_TIMEOUT_MESSAGE } from "./generation-task-runner.service";
import { jobDeadlineMs } from "./job-deadline";
import { ImageGenItemRunnerService } from "./image-gen-item-runner.service";

const TIMEOUT_MESSAGE = "生成超时，请重试";

@Injectable()
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DispatchQueueService,
    private readonly runner: ImageGenItemRunnerService,
    private readonly generationRunner: GenerationTaskRunnerService,
  ) {}

  /** 启动对账:进程崩溃留下的 RUNNING/QUEUED item 恢复或收敛。 */
  async onModuleInit(): Promise<void> {
    void this.reconcile().catch((err) =>
      this.logger.error(`startup reconcile failed: ${String(err)}`),
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.requeueStaleItems();
      await this.convergePastDeadline();
      await this.cleanupExpiredJobs();
      await this.requeueStaleGenerationImages();
      await this.convergePastDeadlineGenerationTasks();
    } finally {
      this.running = false;
    }
  }

  private async requeueStaleItems(): Promise<void> {
    const stale = await this.prisma.imageGenItem.findMany({
      where: {
        status: "RUNNING",
        leaseExpiresAt: { lt: new Date() },
        attemptNo: { lt: this.runner.maxAttempts },
        // 来源隔离：只重投通用生图管线，不碰车泰斗（其 Item 不用这套租约）
        job: { businessType: IMAGE_CREATIVE_BUSINESS_TYPE },
      },
      select: { id: true },
    });
    for (const item of stale) {
      this.queue.enqueue(() => this.runner.executeItem(item.id));
    }
    if (stale.length > 0) {
      this.logger.warn(`requeued ${stale.length} stale item(s) after lease expiry`);
    }
  }

  private async convergePastDeadline(): Promise<void> {
    const jobs = await this.prisma.imageGenJob.findMany({
      where: {
        status: { in: ["QUEUED", "RUNNING"] },
        // 来源隔离：不超时收敛车泰斗批次（按 Job.deadlineAt 由车泰斗对账处理）
        businessType: IMAGE_CREATIVE_BUSINESS_TYPE,
      },
      select: { id: true, kind: true, createdAt: true },
    });
    const now = Date.now();
    for (const job of jobs) {
      if (now - job.createdAt.getTime() <= jobDeadlineMs(job.kind)) continue;
      await this.prisma.imageGenItem.updateMany({
        where: { jobId: job.id, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", errorMessage: TIMEOUT_MESSAGE },
      });
      await this.prisma.imageGenJob.updateMany({
        where: { id: job.id, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED" },
      });
    }
  }

  /** 删除超过审计保留窗口的 ImageGenJob(级联删 item)。终态行不再是
   *  「过期即删」——生成记录视图(usage/generation-records)以 ImageGenJob 为
   *  t2i/i2i 数据源,需要行长期存活;快照轮询的 30 分钟 404 契约由 GET 读路径
   *  按 expiresAt 判定,与这里的清理解耦。默认 0 = 永久保留(与 GenerationTask
   *  同为永久审计口径);设天数只影响生成记录历史,不影响计费。 */
  private async cleanupExpiredJobs(): Promise<void> {
    const retentionDays = Number(process.env.IMAGE_GEN_JOB_RECORD_RETENTION_DAYS ?? 0);
    const cutoff =
      Number.isFinite(retentionDays) && retentionDays > 0
        ? new Date(Date.now() - retentionDays * 86_400_000)
        : null;
    if (!cutoff) return; // 默认永久保留,不清理
    const deleted = await this.prisma.imageGenJob.deleteMany({
      // 来源隔离：CHETAIDOU 行 expiresAt=null 且不参与旧清理
      where: { expiresAt: { lt: cutoff }, businessType: IMAGE_CREATIVE_BUSINESS_TYPE },
    });
    if (deleted.count > 0) {
      this.logger.log(`cleaned ${deleted.count} image-gen job(s) past record retention`);
    }
  }

  /** 主生图:租约过期的 GENERATING 图重投执行(新 attempt;任务已终态的
   *  图由取消/超时事务收敛,不重投)。 */
  private async requeueStaleGenerationImages(): Promise<void> {
    const stale = await this.prisma.generatedImage.findMany({
      where: {
        status: "GENERATING",
        leaseExpiresAt: { lt: new Date() },
        attemptNo: { lt: this.generationRunner.maxAttempts },
        task: { status: "GENERATING" },
      },
      select: { id: true },
    });
    for (const image of stale) {
      this.queue.enqueue(() =>
        this.generationRunner.executeGeneratedImage(image.id),
      );
    }
    if (stale.length > 0) {
      this.logger.warn(
        `requeued ${stale.length} stale generated image(s) after lease expiry`,
      );
    }
  }

  /** 主生图:超 deadlineAt(创建 + 11 分钟)仍未终态的任务收敛 —— 任务
   *  TIMEOUT、GENERATING 图 FAILED,errorMessage 照源超时语义(前端 10 分钟
   *  超时的 PATCH 载荷文案;deadline 含 1 分钟宽限,正常情况下前端自己的
   *  超时先生效,这里只兜底进程崩溃/挂死的任务)。 */
  private async convergePastDeadlineGenerationTasks(): Promise<void> {
    const tasks = await this.prisma.generationTask.findMany({
      where: { status: "GENERATING", deadlineAt: { lt: new Date() } },
      select: { id: true, type: true, executionSpec: true },
    });
    for (const task of tasks) {
      await this.prisma.generatedImage.updateMany({
        where: { taskId: task.id, status: "GENERATING" },
        data: { status: "FAILED", errorMessage: GENERATION_TIMEOUT_MESSAGE },
      });
      await this.prisma.generationTask.updateMany({
        where: { id: task.id, status: "GENERATING" },
        data: { status: "TIMEOUT", errorMessage: GENERATION_TIMEOUT_MESSAGE },
      });
    }
    for (const task of tasks) {
      if (task.type === "PORTRAIT" && (task.executionSpec as { localRedraw?: unknown } | null)?.localRedraw) await this.generationRunner.aggregateTask(task.id)
    }
    if (tasks.length > 0) {
      this.logger.warn(
        `converged ${tasks.length} generation task(s) past deadline to TIMEOUT`,
      );
    }
  }
}
