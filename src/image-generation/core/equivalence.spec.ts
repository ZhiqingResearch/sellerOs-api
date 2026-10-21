// src/image-generation/core/equivalence.spec.ts
//
// 移植等价性门禁(P0):用前端仓库录制的 309 例矩阵逐条重放移植实现。
// 任何一例输出/抛错不一致,或全矩阵 sha256 不匹配,本套件即失败——
// 视为移植行为漂移,禁止进入后续阶段(P1 端点/执行器)。
//
// fixture 同步:见 equivalence-runtime.ts 头注。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type EquivalenceFixture,
  runCase,
  sha256Of,
} from "./equivalence-runtime";

const FIXTURE_PATH = resolve(
  __dirname,
  "__fixtures__/image-core-matrix.json",
);

// it.each 在 describe 求值期就要表格,必须在模块顶层读取。
const fixture: EquivalenceFixture = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf8"),
) as EquivalenceFixture;

// 已记录偏差登记表:前端录制件与 matrixSha256 一律不改,刻意背离前端
// 现状的行为在此显式登记(评审可见、追责可溯),并配套断言防止登记表
// 悄悄失效(录制值漂移/登记项过时都会 fail)。
//
// 2026-09-14 | 网关全目录下线 3K 档(resolution 枚举仅 1k/2k/4k):
// normalizeResolutionTier 对 3K 结果统一降档 2K(存量前端发 3K 不再必 400)。
// 受影响为 legacy 3072 串推导出 3K 的三例;排查与决议见
// docs/references/2026-09-14-imagegen-special-ratio-incidents.md。
const KNOWN_DEVIATIONS: Record<string, { fn: string; result: unknown }> = {
  "norm-tier:null-3072x3072": { fn: "normalizeResolutionTier", result: { value: "2K" } },
  "norm-tier:bogus-3072x3072": { fn: "normalizeResolutionTier", result: { value: "2K" } },
  "norm-tier:4-3072x3072": { fn: "normalizeResolutionTier", result: { value: "2K" } },
};

describe("image-core port equivalence (vs amazon-agent recorded matrix)", () => {
  it("fixture schema and size sanity", () => {
    expect(fixture.schema).toBe(1);
    expect(fixture.caseCount).toBeGreaterThan(250);
    expect(fixture.cases).toHaveLength(fixture.caseCount);
    const ids = new Set(fixture.cases.map((c) => c.id));
    expect(ids.size).toBe(fixture.caseCount);
  });

  it("global matrix sha256 matches frontend recording", () => {
    expect(sha256Of(fixture.cases)).toBe(fixture.matrixSha256);
  });

  it("known deviations stay registered against their recorded values (登记有效性)", () => {
    for (const [id, deviation] of Object.entries(KNOWN_DEVIATIONS)) {
      const recorded = fixture.cases.find((c) => c.id === id);
      expect(recorded).toBeDefined();
      expect(recorded!.fn).toBe(deviation.fn);
      // 录制值须仍是旧口径(3K);前端重录后若对齐新口径,登记应删除。
      expect(recorded!.result).toEqual({ value: "3K" });
      expect(deviation.result).not.toEqual(recorded!.result);
    }
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))(
    "case %s",
    (_id, c) => {
      const replayed = runCase(c.fn, c.args);
      const deviation = KNOWN_DEVIATIONS[c.id];
      expect(replayed).toEqual(deviation ? deviation.result : c.result);
    },
  );
});
