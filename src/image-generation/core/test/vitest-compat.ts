// vitest → jest 兼容垫片。
//
// amazon-agent 的图像核心测试用 vitest 编写;移植到本仓库(Jest + ts-jest)
// 时保留 `vi.*` 调用点,由本垫片映射到 jest 等价物。仅覆盖移植测试实际
// 用到的 API 子集——出现新的 vi API 用法时在此补充,不要改测试本体。

type AnyFn = (...args: unknown[]) => unknown;

const stubbedGlobals = new Map<string, unknown>();

export const vi = {
  fn: (impl?: AnyFn) => (impl ? jest.fn(impl) : jest.fn()),
  spyOn: (obj: object, key: string) =>
    jest.spyOn(obj as never, key as never) as unknown as ReturnType<
      typeof jest.spyOn
    >,
  useFakeTimers: (): void => { jest.useFakeTimers(); },
  useRealTimers: (): void => { jest.useRealTimers(); },
  restoreAllMocks: (): void => { jest.restoreAllMocks(); },
  advanceTimersByTimeAsync: (ms: number): Promise<void> =>
    jest.advanceTimersByTimeAsync(ms),
  runAllTimersAsync: (): Promise<void> => jest.runAllTimersAsync(),
  stubGlobal: (name: string, value: unknown): void => {
    if (!stubbedGlobals.has(name)) {
      stubbedGlobals.set(name, (globalThis as Record<string, unknown>)[name]);
    }
    (globalThis as Record<string, unknown>)[name] = value;
  },
  unstubAllGlobals: (): void => {
    for (const [name, original] of stubbedGlobals) {
      if (original === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        (globalThis as Record<string, unknown>)[name] = original;
      }
    }
    stubbedGlobals.clear();
  },
};
