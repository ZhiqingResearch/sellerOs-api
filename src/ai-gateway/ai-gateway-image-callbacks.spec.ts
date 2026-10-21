// src/ai-gateway/ai-gateway-image-callbacks.spec.ts
//
// image.task 终态回调枢纽单测:waiter 注册/唤醒、非终态过滤、无 waiter
// 近期缓存(快任务竞态)、release 防泄漏、TTL 清扫。

import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk";
import { AiGatewayImageCallbacksService } from "./ai-gateway-image-callbacks.service";

const task = (id: string, status: ImageTask["status"]): ImageTask =>
  ({
    id,
    object: "image.task",
    status,
    model: "ZQ-Image-2",
    request_id: `req_${id}`,
    created_at: 1,
    completed_at: 2,
  }) as unknown as ImageTask;

describe("AiGatewayImageCallbacksService", () => {
  it("waitForTerminal 被 notify 的终态唤醒", async () => {
    const hub = new AiGatewayImageCallbacksService();
    const pending = hub.waitForTerminal("t1");
    expect(hub.notify(task("t1", "succeeded"))).toBe(true);
    await expect(pending).resolves.toMatchObject({ id: "t1", status: "succeeded" });
  });

  it("非终态事件不唤醒 waiter,但有 waiter 时拦截(不走 GenerationTask 兜底)", async () => {
    const hub = new AiGatewayImageCallbacksService();
    const pending = hub.waitForTerminal("t2");
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    expect(hub.notify(task("t2", "queued"))).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    expect(hub.notify(task("t2", "succeeded"))).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "succeeded" });
  });

  it("无 waiter 的终态进近期缓存:waitForTerminal 之后调用立即取走", async () => {
    const hub = new AiGatewayImageCallbacksService();
    expect(hub.notify(task("t3", "failed"))).toBe(false);
    await expect(hub.waitForTerminal("t3")).resolves.toMatchObject({ status: "failed" });
  });

  it("release 后 notify 不再唤醒,退化为近期缓存", async () => {
    const hub = new AiGatewayImageCallbacksService();
    const pending = hub.waitForTerminal("t4");
    hub.release("t4");
    expect(hub.notify(task("t4", "succeeded"))).toBe(false);
    // 原 promise 保持 pending(release 语义:provider 已自行了断)
    const race = await Promise.race([
      pending.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(race).toBe("pending");
  });

  it("近期缓存 60s 过期清扫", async () => {
    const hub = new AiGatewayImageCallbacksService();
    expect(hub.notify(task("t5", "succeeded"))).toBe(false);
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.now() + 61_000);
      const pending = hub.waitForTerminal("t5");
      const race = Promise.race([
        pending.then(() => "resolved"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 5)),
      ]);
      jest.advanceTimersByTime(5);
      expect(await race).toBe("pending");
    } finally {
      jest.useRealTimers();
    }
  });
});
