# 车泰斗组合校验修复 · 前端联调文档

日期：2026-10-06。状态：后端本地实现与自动化验证；前端仅提供联调说明，未修改前端代码。生产环境尚未部署。

本次修复按 PRD F12/F13/A7 实现：格式错误由服务端最多自动修复一次；真实软性冲突交给用户取舍；答案再次通过组合校验后才能生图。没有新增接口、数据库表或必配环境变量。

## 1. 交付范围

后端：

- `ready` 与 `needs_resolution` 分支校验，合法精简冲突结果不再因缺少最终文案字段而失败。
- JSON 解析错误及结构/业务校验错误均可进入组合专用修复，携带冻结规则、完整输入、上次响应、具体错误和 Schema。
- 每个 COMPOSE 任务最多一次原始调用和一次修复调用。已有 Call 使用保存的请求/响应，未知状态不重发。
- 修复可返回冲突问题，不能强迫生成 READY。中文失败提示与内部技术错误分离。
- 文案模式、目标语言、准确文案、选择覆盖及有效决策检查；文案取舍只对有效非阻断决策明确命名的选择生效。
- 同名但不同问题/来源的历史决定不再被覆盖；存在任何阻断问题时拒绝答案提交。

前端待实施（本次仅交付文档，不修改前端代码）：

- 状态适配：精确映射 READY / NEEDS_RESOLUTION / 阻断 / 失败 / 待核对；保留 errorCode 和 stage。
- 进度与界面：修复进度、待确认/阻断/待核对标签，当前在途组合防重复提交。
- 答案提交：直接走 answers 接口，禁止先保存草稿；传真实 questionVersion；同步后端返回的 revision 和新组合指针。
- 回归测试：覆盖本文第 6 节，特别是精简冲突结构、答案提交不发生草稿 PUT、多轮版本同步和未知状态不重发。

若沿用 `../chetaidou-studio-main` 原型，可在 `public/studio-backend.mjs`、`public/studio-settings.mjs`、`public/studio.js` 对应适配；SellerOS 正式前端按自身结构实现下述协议。当前原型代码未包含本次修复，不能直接视为已完成联调。

## 2. 请求顺序

所有接口使用用户 Bearer Token，路径前缀为 `/api/chetaidou`。

### 2.1 首次组织或用户主动重新组织

1. 如用户修改过草稿，先按现有 CAS 契约保存草稿，采用返回的 `revision`。
2. 创建 COMPOSE 任务：

```http
POST /api/chetaidou/tasks
Content-Type: application/json
```

```json
{
  "type": "COMPOSE",
  "imageId": 19,
  "idempotencyKey": "4c577a9c-e89d-41cd-a98b-ce61bdf1a6cf",
  "draftRevision": 10
}
```

响应示例：

```json
{
  "taskId": "新组合任务ID",
  "status": "QUEUED",
  "acceptedDraftRevision": 11
}
```

立即保存新 `taskId` 为当前组合指针，采用 `acceptedDraftRevision`，不能继续使用提交前版本或自行猜测版本。幂等重放若只返回 `taskId`，重读 `GET /images/:imageId/draft` 获取服务器版本及当前指针。

### 2.2 查询执行状态与产物

- `GET /api/chetaidou/tasks/:taskId`：执行状态、`stage`、`errorCode`、`errorMessage`。
- `GET /api/chetaidou/tasks/:taskId/output`：返回 `{compositionTaskId, output}`；未产生合格结果时 `output` 可为 null。
- `GET /api/chetaidou/compositions/:taskId`：额外取得 `isStale`、`staleReason`，供旧结果只读判断。

执行状态 `task.status` 与业务状态 `output.status` 必须分开。API 业务状态为大写，模型内部的小写状态不是前端协议。

## 3. 页面状态表

| task.status | output / stage | 页面与按钮 |
|---|---|---|
| QUEUED | 无产物 | 排队中；当前未修改草稿不重复提交；禁用生图 |
| RUNNING | `组织编辑指令中` | 显示处理中；禁用生图 |
| RUNNING | `正在修复组合结果格式` | 显示服务端阶段，说明本轮最多自动修复一次；不另发修复请求 |
| SUCCEEDED | `output.status=NEEDS_RESOLUTION`，全部 `blocking=false` | 待确认；展示问题与处理方案；禁用生图 |
| SUCCEEDED | 冲突中任一 `blocking=true` | 需调整选择/核实资料；禁止提交答案；禁用生图 |
| SUCCEEDED | `output.status=READY` 且当前上下文未过期 | 展示结果；允许用户提交生图 |
| FAILED | `errorCode=MODEL_OUTPUT_INVALID` | 显示中文 `errorMessage`；保留已选内容，允许用户重新组织 |
| WAITING_RECONCILIATION | `errorCode=CALL_STATUS_UNKNOWN` | 状态待核对，请勿重复提交；不自动重试模型，不显示为普通格式失败 |
| 任意 | 产物缺失或未知业务状态 | 不展示空冲突卡片，不允许生图 |

本次后端硬阻断仍使用 `NEEDS_RESOLUTION + conflicts[].blocking`。前端保留对已有 `BLOCKED` 业务状态的阻断兼容，不将它误映射为普通待回答冲突。

旧版本可能把所有非 READY 结果映射为 `needs_resolution`，必须删除这种二选一写法。若前端保留 `WAITING_RECONCILIATION -> interrupted` 的内部执行状态映射，建议另增加前端派生字段 `needsReconciliation`，用于显示“状态待核对”；该字段不是后端新增接口字段。

组合校验未通过时统一提示（包括自动修复关闭或修复未成功）：

```json
{
  "status": "FAILED",
  "errorCode": "MODEL_OUTPUT_INVALID",
  "errorMessage": "本次未能完成组合，请点击「重新组织」再试一次，已选内容会保留。"
}
```

新任务写入友好中文提示；历史任务在详情、列表和批量状态读取时统一转换，不修改历史数据库记录。前端直接展示 errorMessage，不展示内部错误码或 AJV 校验详情。错误码 MODEL_OUTPUT_INVALID 保留供程序判断，原始技术错误仍保留在 Call 账本中。前端已有缓存若包含旧英文错误，刷新任务数据后即可替换，也可按错误码使用同一中文提示。

## 4. 冲突卡片与答案

产物示例（仅展示相关字段）：

```json
{
  "compositionTaskId": "当前组合任务ID",
  "output": {
    "status": "NEEDS_RESOLUTION",
    "summaryCn": "两条文案表达不同方案，需要确定保留哪条",
    "editPromptEn": null,
    "conflicts": [
      {
        "id": "copyChoice",
        "questionVersion": 1,
        "question": "保留哪条文案？",
        "reason": "两条文案要求不能同时满足",
        "sources": ["选择A的selectionId", "选择B的selectionId"],
        "blocking": false,
        "choices": [
          { "id": "keepA", "label": "保留文案 A", "instruction": "保留 A，放弃 B" },
          { "id": "keepB", "label": "保留文案 B", "instruction": "保留 B，放弃 A" }
        ]
      }
    ],
    "coveredSelectionIds": [],
    "changedFeatures": [],
    "preservedFeatures": [],
    "textReplacements": [],
    "copyAdditions": [],
    "acknowledgedAnswerIds": []
  }
}
```

- 按服务器返回的 `question/reason/choices[].label` 展示中文卡片，提供单选及自由文字。
- `sources` 用于显示涉及的设置/选择，不要把显示文案或前端拼接 option ID 当成服务器 selectionId。
- 任一阻断问题存在时，整个“提交全部答案并重新检查”入口不可用；引导用户修改草稿。
- 答案输入按 `compositionTaskId + 问题版本/内容/来源` 隔离缓存，不能仅凭同名 `conflictId` 复用。
- 回答冲突不需要在前端删除被放弃的选择。服务端保存决策，最终仍精确覆盖原选择，文案按有效答案取舍。

提交接口：

```http
POST /api/chetaidou/compositions/:compositionTaskId/answers
Content-Type: application/json
```

```json
{
  "idempotencyKey": "ca05ec78-6c57-4210-bbc1-5012f4115cbd",
  "draftRevision": 11,
  "answers": [
    {
      "conflictId": "copyChoice",
      "questionVersion": 1,
      "choiceId": "keepA",
      "text": "保留短文案，位置不变"
    }
  ]
}
```

`choiceId` 或非空 `text` 至少提供一个，允许同时提供；text 去首尾空格后不超过 1000 字。必须一次提交全部非阻断问题，每个问题一次；`questionVersion` 取服务器返回值。客户端不能发送决策 ID、scopeKey、原冲突或自定义指令来替代服务器依据。

首次成功响应 HTTP 202：

```json
{
  "taskId": "下一轮组合任务ID",
  "acceptedDraftRevision": 12
}
```

**关键：答案提交直接走 answers 接口，之前不要 PUT 保存草稿。** 保存草稿可能改变 revision 和当前组合指针，导致答案提交失败。收到响应后采用新任务 ID 和服务器 revision，轮询下一轮。点击选项本身不触发模型调用，提交全部答案才触发。

网络重试同一次请求时重用同一幂等键和相同请求体；用户主动提交新的一轮才创建新幂等键。幂等命中可能只返回 `{taskId}`，重读服务器草稿，不推算 revision。

常见失败处理：

| 响应 | 处理 |
|---|---|
| 400 缺少答案/选项不存在/包含阻断问题 | 留在问题页，提示修正；不自动发下一轮 |
| 409 当前组合或草稿变化 | 重读草稿/组合，保留未保存的用户输入，不能强行套用旧答案 |
| 409 问题版本变化 | 重载最新问题，按新问题重新作答 |

## 5. 生图门槛与费用

继续使用现有 GENERATE 接口，传最终通过的 `compositionTaskId`。只有执行成功、业务 READY、当前上下文一致且未过期时启用按钮；服务端仍进行权威校验。待回答冲突不得携带可执行英文提示词。

- 本地校验、轮询、展示问题、选择答案不产生模型调用。
- 一轮正常组合 1 次；发生内容修复时最多 2 次。
- 每次提交全部答案创建下一轮，下一轮同样最多 2 次。
- 原始不合格输出和修复调用均按供应商实际账单结算，修复失败不等于免费。
- `CHETAIDOU_REPAIR_BUDGET=0` 可关闭自动修复；COMPOSE 对正数预算始终最多修复一次。
- 未知调用不自动重发；账单结算重试不重新调用模型。

## 6. 联调验收清单

1. 合法精简冲突结果直接展示卡片，不额外调用修复模型。
2. 模型返回缺字段结果，页面进入修复阶段；修复正常后可展示 READY。
3. 修复后发现真实冲突，展示处理选项而非报错或直接开放生图。
4. 回答全部问题时不发生草稿 PUT；响应后采用新 revision/任务指针。
5. 下一轮复用同名 ID 但问的是不同问题时，之前有效决定仍保留。
6. 文案取舍后 coveredSelectionIds 仍覆盖全部原选择，其他文案不得无依据丢失。
7. 有任一 blocking 问题时不允许提交答案，直接请求也返回 400。
8. 修复两次输出均不合格时总模型调用数为 2，没有第三次自动修复，用户选择仍保留。
9. 修复网络超时进入待核对；刷新/重复任务执行不重新调用网关。
10. FAILED、RUNNING、缺失产物和未知业务状态不能展示“待回答”卡片或开放生图。
11. 草稿修改后旧组合失效，晚到结果不重新成为当前可生图结果。
12. 重放已保存响应复用原 Call；结算幂等维持原有规则。

## 7. 本地验证与发布说明

已完成：

- 后端车泰斗 Jest：9 个套件、101 项全部通过（含组合契约、修复、决策与调用复用用例）。
- 后端生产构建与本次改动文件的只读 ESLint 检查。
前端联调与页面验收由前端按本文实施后执行。本次只交付联调文档，不包含前端代码或补丁。

未执行真实付费模型调用、真实数据库并发压测或生产部署。模型语义效果仍需在联调环境选少量真实样本验收；单元测试通过不等于模型每次都能正确识别全部冲突。

新提示词版本：`a1-20261006-compose-repair-v3`。已有任务快照及已创建 Call 的请求不改写；新任务使用新版本。已有失败任务需要用户主动重新组织，不批量重放历史调用。

本次交付仅包含后端代码、测试和联调文档；提交与分支合并状态以 Git 记录为准。本次未修改 Prisma Schema，无需执行数据库同步命令。
