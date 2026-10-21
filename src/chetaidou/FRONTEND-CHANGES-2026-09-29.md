# 车泰斗前端修改指南（2026-09-29 联调修复）

适用：前端 `dev-2.3.0`，对接本次车泰斗后端改动。本文按当前后端 Controller、DTO、Service 核对，供前端直接拆分开发任务；不要求重写页面或引入新的状态管理库。

本次只提供前端方案，未修改前端仓库。下文组件名称按职责描述，不是已核实的前端文件路径。请求示例中的 ID、revision 均为示意，实际必须使用接口返回值。

## 1. 先看修改范围和实施顺序

| 顺序 | 修改位置（按职责定位） | 要做什么 |
|---|---|---|
| 1 | API 类型、请求封装、权限配置 | 更新权限 key；补新字段和 discard 接口；统一任务响应 ID |
| 2 | 工作台草稿状态、组合面板 | 服务端草稿恢复最新组合；保存与任务提交串行；正确处理 revision 和过期 |
| 3 | 冲突问答、自建维度、发散卡片 | 冻结冲突结构；稳定 ID；应用/放弃；本地答案恢复 |
| 4 | 任务中心、母版列表、预览墙 | 目标维度、重试与取消、多状态筛选、缩略图、摘要和下载 |
| 5 | 表单与提示 | 删除过时限制；人物说明；三态货篮；生成张数恢复 |
| 6 | 联调 | 按第 12 节逐项验收 |

最简实现：继续使用现有 API 层和页面状态；服务端草稿是已保存数据的依据，本地只缓存未提交答案和张数。涉及草稿的操作成功后统一重新 GET 草稿，省掉客户端模拟后端 revision、指针和选项合并的逻辑。

### 联调环境状态

2026-09-29 已在 `agent-dev-new` 执行本次维护：新车泰斗权限节点和角色授权已存在，旧节点不存在；补齐 6 张历史母版缩略图，复查待补数为 0。数据库准备完成不代表新后端已部署，本次操作未部署或重启服务；联调前确认 API 实例已运行本次后端代码。

## 2. API 公共约定和权限

所有业务接口前缀为 `/api/chetaidou`，使用现有用户 Bearer Token。以下表格中的路径省略该前缀。

### 2.1 权限 key

菜单、RouteGuard、页面按钮可见性统一使用：

```ts
const CHETAIDOU_PERMISSION = 'tool.ai_creative_studio.chetaidou';
```

删除车泰斗页面的 RouteGuard 临时白名单和对 `tool.chetaidou` 的依赖。沿用现有点号祖先继承规则，持有 `tool.ai_creative_studio` 或更上级权限也可访问。管理端权限 `management.chetaidou` 不变。

后端已经校验权限。403 显示后端中文提示并提供返回入口，不循环重试，不通过白名单绕过。

### 2.2 幂等键和任务响应

一次用户操作生成一个 UUID。网络超时后重发**同一请求**时沿用该 UUID 和请求内容；用户修改输入、开始新的操作或主动重试失败任务时使用新 UUID。请求仍在发送时禁用重复提交按钮。

当前 `POST /tasks` 首次提交一般返回 `{taskId, status?, acceptedDraftRevision?}`，幂等命中可能返回任务详情 `{id, ...}`；答案提交、重试返回 `{taskId, ...}`。在 API 适配层统一一次：

```ts
function submittedTaskId(data: { taskId?: string; id?: string }) {
  const id = data.taskId ?? data.id;
  if (!id) throw new Error('任务响应缺少 ID，请刷新后查看任务列表');
  return id;
}
```

`acceptedDraftRevision` 是可选字段，不能假定每个接口或幂等响应都有。提交成功后 GET 草稿获取最终 revision，不在本地自行 `revision++`。

### 2.3 新增或需要更新的接口

| 接口 | 前端调整 |
|---|---|
| `GET /images/:id/draft` | 接收 `ideationStale`、`staleReason`；按 `activeCompositionTaskId` 恢复组合 |
| `PUT /images/:id/draft` | 接收服务端分配的维度 ID/选项 key；处理 409 的 `details.currentDraft` |
| `GET /compositions/:id` | 同时读取任务 `status`、`output.status`、`isStale` |
| `POST /compositions/:id/answers` | 严格使用 conflict ID/version 和 choice ID，一次提交全部非阻断问题 |
| `GET /tasks`、`GET /tasks/:id`、`GET /tasks/status` | 接收 `target`、`updatedAt`、`imageTitle`、`imageNumber` |
| `GET /tasks?status=QUEUED,RUNNING` | 多状态 OR 筛选，使用返回的 total |
| `GET /tasks/:id/output` | DIVERGE 读取完整产物及应用/放弃标记 |
| `POST /tasks/:id/apply` | `{draftRevision}`；成功后重读草稿和产物 |
| `POST /tasks/:id/discard` | **新增**，无请求体；仅放弃成功且未应用的 DIVERGE 产物 |
| `GET /skus/:skuId/images` | 读取 `thumbnailUrl`、`activeBreakdownTask` |
| `GET /skus/:skuId/results` | 读取 `compositionTaskId`、`summaryCn` |
| `GET /results/:id/download` | 使用返回的 `url`、`filename`、`expiresAt` |

## 3. 草稿、页面恢复与组合

### 3.1 草稿字段

保留现有 settings/selections/customDimensions 类型，补齐以下响应字段：

```ts
interface DraftStateFields {
  revision: number;
  acknowledgedBreakdownId: number | null;
  activeIdeationTaskId: string | null;
  activeCompositionTaskId: string | null;
  activeGroupRefs: Array<{ groupId: string }>;
  pendingRefreshTaskId: string | null;
  ideationStale: boolean;
  staleReason: string | null;
}
```

首次 GET 草稿会创建并返回默认草稿，revision 为 0；正常情况下不需要用 404 创建本地伪草稿。

### 3.2 进入页面或刷新后的顺序

1. 读取 config、母版详情和草稿。
2. 渲染草稿设置、自建维度和选择；按 `activeGroupRefs` 恢复当前生效的联想组。
3. 若 `activeCompositionTaskId` 非空，调用 `GET /compositions/:id`。该指针现在覆盖排队、运行、待回答、失败等状态，不再只代表 READY。
4. 若指针为空，组合面板显示“请重新组合”。历史任务仍可只读查看，但不能把历史 READY 任务补成当前组合。
5. 读取该母版相关任务，按 target 恢复维度上的发散/刷新状态；按原有轮询方式跟踪未完成任务。

每轮回答会新建一个 COMPOSE 根任务，`parentTaskId` 连接上一轮；任务列表会展示这些轮次。恢复当前轮次以草稿指针为准，不从“最新成功任务”猜测。

### 3.3 保存与提交顺序

“保存草稿 → 拿到保存响应 → 提交任务 → 重读草稿”依次执行。自动保存尚未完成时，先等待它完成，避免保存和 COMPOSE/GENERATE 并发提交旧 revision。

PUT 草稿仍提交完整可编辑部分：

```ts
await api.put(`/images/${imageId}/draft`, {
  revision: savedDraft.revision,
  settings: editedSettings,
  selections: editedSelections,
  customDimensions: editedDimensions,
});
```

不要把草稿的任务指针、过期标记等只读字段加入 PUT。

创建组合示例：

```json
{
  "type": "COMPOSE",
  "imageId": 19,
  "idempotencyKey": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 6
}
```

接口为 `POST /tasks`。创建成功立即重读草稿，再按新指针读组合。组合运行时 `output` 可以为 null，不能当失败。

### 3.4 分开判断“任务完成”和“允许生图”

| 返回值 | 页面行为 |
|---|---|
| 任务 QUEUED/RUNNING | 显示进度，继续轮询 |
| WAITING_RECONCILIATION | 显示“待核对”，不当失败，不重复发起同一次调用 |
| SUCCEEDED + `output.status=NEEDS_RESOLUTION` | 渲染冲突问答 |
| `conflicts.some(c => c.blocking)` | 显示需修改输入的阻断原因，不为阻断问题提交答案 |
| SUCCEEDED + `output.status=READY` | 结合下面条件开放生图 |
| `isStale=true` | 只读展示，禁止回答和生图，提示重新组合 |
| FAILED/CANCELLED | 按任务状态提示，不因残留 output 放开生图 |

不要只靠 `output.status=BLOCKED` 判断阻断；以 conflicts 的 blocking 字段判断，旧数据若返回 BLOCKED 也禁止生图。

```ts
const canGenerate =
  !hasUnsavedChanges &&
  draft.activeCompositionTaskId === composition.compositionTaskId &&
  composition.status === 'SUCCEEDED' &&
  composition.output?.status === 'READY' &&
  !composition.output.conflicts.some(c => c.blocking) &&
  !composition.isStale;
```

另叠加页面既有的功能开关、模型就绪和提交中状态。点击生图发送：

```json
{
  "type": "GENERATE",
  "imageId": 19,
  "idempotencyKey": "59cfb7a3-0b7c-45ad-a4a2-6c5942b82d15",
  "draftRevision": 7,
  "compositionTaskId": "5ba94a6c-c4b7-4765-9143-62b84654753b",
  "count": 4
}
```

### 3.5 联想过期

`ideationStale=true` 时，旧联想选项继续显示，展示 `staleReason`，禁止使用旧联想选项组合或刷新该组，引导“重新联想”。不要直接删除旧方案，也不要靠本地指纹作为唯一依据。

仅用自建维度、没有使用旧联想内容的组合，不因未使用的旧联想过期而整体禁用；最终仍以后端校验为准。设置、事实卡、母版或拆解版本变化均可能导致过期，不能只监听本地设置变化。

### 3.6 草稿 409 冲突

PUT 草稿可能返回：

```json
{
  "statusCode": 409,
  "code": "SETTINGS_CHANGED",
  "message": "草稿已被其他操作更新，请刷新后重试",
  "details": {
    "retryable": false,
    "currentRevision": 8,
    "currentDraft": "此处实际为完整草稿对象"
  }
}
```

保留本地未保存输入，沿用现有三方合并：比较上次服务端版本、本地编辑版本、最新服务端版本；仅本地变化可保留，同一字段两边都改则以服务端为准并提示。用户确认后以最新 revision 保存。不要自动只换 revision 再覆盖提交整份旧草稿。

创建任务或 apply 的 409 不一定带 currentDraft，也可能没有业务 code；缺少时 GET 草稿，再提示处理。后台重读草稿时若本地仍有未保存输入，也走这套合并，不能直接覆盖输入框。

## 4. 冲突问答与答案恢复

### 4.1 字段固定

```ts
interface Conflict {
  id: string;
  questionVersion: number;
  question: string;
  reason: string;
  sources: string[];
  choices: Array<{ id: string; label: string; instruction: string }>;
  blocking: boolean;
}
```

展示 question/reason/choices[].label。`choices[].instruction` 是所选决策的执行说明，后端会按 choiceId 取用，前端无需自行拼进提示词。sources 用于解释冲突来源。新响应按上述字段消费，不再猜 conflictId/choiceId 别名；若保留历史兼容，应放在 API 适配层。

存在 blocking 问题时，先提示用户调整相关选择/设置并重新组合。非阻断问题每个必须选一项或输入非空自由文字（最多 1000 字），一轮一次提交全部问题，不能漏答、重复 conflictId 或提交旧问题版本。

`POST /compositions/:compositionTaskId/answers`：

```json
{
  "idempotencyKey": "2e59bc2f-5cfe-4aca-9954-5eaeb57c266f",
  "draftRevision": 7,
  "answers": [
    { "conflictId": "c1", "questionVersion": 1, "choiceId": "choice_1" },
    { "conflictId": "c2", "questionVersion": 2, "text": "保留背景，只调整人物服装" }
  ]
}
```

成功后使用返回的新 taskId 跟踪任务，并重读草稿；不要继续对上一轮 ID 提交答案。若收到 SOURCE_VERSION_CHANGED，重新获取当前组合问题，丢弃不匹配版本的本地答案。

### 4.2 未提交答案只需本地保存

localStorage key：`chetaidou:<userId>:<imageId>:answers:<compositionTaskId>`。value 保存 `{answers:[{conflictId,questionVersion,choiceId?,text?}]}`。

- 恢复时先取服务端当前组合，只恢复当前仍存在、版本一致、非阻断的问题；choiceId 也必须仍在 choices 内。
- 当前组合失效或切换到新组合时不恢复旧轮答案；提交成功后删除旧轮缓存。
- 接口超时不算提交成功，保留输入和原幂等请求，供同一请求重试。
- 不存 JWT、签名 URL、完整模型产物或已生效决策。已生效决策由后端组合链维护。
- JSON 损坏或 localStorage 不可用时回退内存，不能阻断作答。

本期不做跨设备答案同步，不新增答案保存接口。

## 5. 自建维度、AI 发散与换一批

### 5.1 新建时省略 ID/key，保存后再选中

新维度和手写方案提交形式：

```json
{
  "label": "海边场景",
  "selectionMode": "single",
  "guidance": "偏度假休闲风",
  "options": [{ "text": "背景换成海边栈道" }],
  "selectedKeys": []
}
```

放入 PUT 草稿的 customDimensions。服务端按原顺序返回分配好的维度 id、选项 key；用响应替换已保存对象。若用户要直接选中新方案，拿到真实 key 后更新 selectedKeys 并再次保存，再提交组合。

已有维度/选项必须保留原 id/key，不能每次渲染生成新 ID，也不要把前端临时 key 当服务端 ID。`single` 最多选一项，`multi` 可多选。

草稿选项返回 `{key,text,origin,sourceTaskId?}`，origin 为 USER/AI，显示 AI 标签仅依据服务端来源。编辑保存时可以原样透传来源字段，但不能靠修改 origin 改变归属。旧项来源无法确认时不伪造 AI 标签。

### 5.2 发散调用与容量

先保存自建维度，取得稳定 id，再 `POST /tasks`：

```json
{
  "type": "DIVERGE",
  "imageId": 19,
  "idempotencyKey": "fb0346e9-f88f-465f-a8a4-dd13e6208a0c",
  "draftRevision": 9,
  "customDimensionId": "dim_服务端返回的实际ID"
}
```

每维累计上限为 `config.limits.maxOptionsPerDimension`（当前 300），剩余容量至少 `minOptionsPerGroup`（当前 30）才可发散。已有 270 项可以发散，271 项不可以；不增加 240 项门槛。收到 DIMENSION_CAPACITY_EXCEEDED 提示“请先删减方案”，不能提示“等待当前任务完成”。

### 5.3 发散完成后：不要客户端再追加一遍

成功后 GET `/tasks/:id/output`，直接返回发散产物，没有额外 output 包装层：

```ts
interface DivergeOutput {
  customDimensionId: string;
  newOptions: Array<{ key: string; label: string; origin?: 'AI'; sourceTaskId?: string }>;
  newOptionCount: number;
  applied: boolean;
  canApply: boolean;
  appliedDraftRevision?: number;
  discarded?: boolean;
}
```

这里 newOptions 中的展示文案字段是 **label**；应用后的草稿 options 文案字段是 **text**。产物实际还可能带其他选项字段，以上仅列本次页面所需部分。

| 产物状态 | 前端操作 |
|---|---|
| `applied=true` | 后端已写草稿，重读草稿；用 newOptionCount 提示本次产出数量，不再本地追加 |
| 未应用、未放弃、`canApply=true` | 保留完整产物，显示“应用到当前草稿 / 放弃” |
| `discarded=true` | 刷新后也不再弹应用提示；历史任务仍可查看 |
| 未应用且 `newOptionCount=0` | 提示本次无新增方案，不展示无意义的应用操作 |

newOptionCount 表示产出数量；草稿变化后手动应用会再次去重，实际新增量可能更少，不把该字段承诺为最终新增量。

应用：`POST /tasks/:id/apply`，body 为 `{ "draftRevision": 10 }`。先保存或处理未保存编辑，再让用户确认，使用最新 revision 提交。成功返回 `{applied:true, revision, alreadyApplied?}`，重读草稿和 output。重复应用不会重复追加。

放弃：`POST /tasks/:id/discard`，无 body，成功 `{discarded:true}`；重复放弃幂等。已应用产物不能放弃，改为在草稿中删除方案并保存。放弃不退回已发生的调用费用。

应用遇到 409 时保留产物，读取最新草稿并提示重新确认，不悄悄循环应用。目标维度已删除时提示原因，不自动重建维度。

### 5.4 删除历史不需要前端上传

删除方案照常保存草稿即可。后端按用户、母版、稳定自建维度 id 收集历史发散产物，已删除/已放弃方案参与后续避重。不要新增 history 字段或另造历史存储。删掉整个维度再新建属于新维度，不沿用原维度身份；不承诺完全消除语义近似表达。

### 5.5 联想维度“换一批”

保留 `capabilities.refreshGroup`。用 `POST /tasks` 传 `type=REFRESH_GROUP`、imageId、groupId（旧组）、draftRevision、idempotencyKey。草稿 `pendingRefreshTaskId` 非空时仍可使用当前选择组织提示词；不因整轮联想状态、必需维度缺失或刷新中禁用组合。`allowPartialIdeation` 无需传入。生图按当前组合 READY、来源有效及草稿版本等条件判断。

任务完成后重读 output 和草稿，产物字段包括 `newGroupId`、`parentGroupId`、`newOptionCount`、`applied`、`canApply`、`appliedDraftRevision`。已自动应用时用草稿 activeGroupRefs/selections 更新页面；未应用时经用户确认调用 apply。新旧 groupId 是不同版本，不能只替换选项文字却保留旧 groupId。

读取完整组选项仍用 `GET /tasks/:producerTaskId/groups/:groupId`。刷新组的 producer 是产出该组的 REFRESH_GROUP 根任务，不一定是原 IDEATION；从任务详情 groups 建立 groupId → 产出根任务的映射，分页加载所需历史任务。单组响应也返回 producerTaskId。discard 接口本期只用于 DIVERGE，不用于 REFRESH_GROUP。

## 6. 任务中心、轮询、取消与重试

### 6.1 目标和母版信息

任务列表、详情和状态快照补充字段：

```ts
interface TaskExtraFields {
  updatedAt: string; // ISO 时间
  target: { customDimensionId?: string; groupId?: string } | null;
  imageTitle: string | null;
  imageNumber: string | null;
}
```

DIVERGE 用 target.customDimensionId 挂到自建维度卡片；REFRESH_GROUP 用 target.groupId 挂到旧组卡片；其他类型 target 为 null。母版名称优先用任务返回值，缺失时才回退“母版 #id”，不用为了标题补全整个母版目录。

### 6.2 多状态筛选和快照防倒退

后台排队/执行数量可一次查询：`GET /tasks?imageId=19&status=QUEUED,RUNNING&page=1&pageSize=1`，取 total。是否包含待核对由页面统计口径决定，需要时加 `WAITING_RECONCILIATION`，不能把它当 FAILED。

轮询继续使用 `GET /tasks/status?ids=<id1>,<id2>`，返回 `{items:[...]}`。状态快照里的图片子项名是 `resultItems`，任务详情里的名称是 `items`；快照只含 resultId/index/status，不含图片 URL。状态变化后按需重读任务详情、组合或 output。

按 taskId 比较 updatedAt，较旧快照不覆盖新快照；时间相同时继续使用现有请求序号保护。不要把“status 没变”当作无需更新，进度、子项、错误原因仍可能变化。签名 URL 续签不一定改变 updatedAt，显式重新获取的 URL 单独更新。

### 6.3 取消

- 文本任务：仅 QUEUED 提供取消，RUNNING 不显示强制停止按钮。
- GENERATE：有 QUEUED 图片位置即可调用 `POST /tasks/:id/cancel`，文案“取消未开始的图片”；已提交的图片继续等待结果。
- 取消请求后重读状态，不能本地把全部图片直接标记 CANCELLED。状态竞争导致取消失败时，展示后端提示并刷新。

### 6.4 定向重试

保留 `capabilities.targetedRetry`，只对 FAILED 位置提供操作。SETTLING、DELIVERY_PENDING、UNKNOWN 和 WAITING_RECONCILIATION 都不是可重试失败。

| 场景 | 请求 |
|---|---|
| 联想/刷新失败维度 | `POST /tasks/:rootTaskId/retry`，`{idempotencyKey,draftRevision,groupIds:[失败组ID]}` |
| 失败图片 | 同上，`{idempotencyKey,resultIds:[失败resultId]}` |
| 上传图拆解失败 | `POST /images/:imageId/breakdown/retry`，`{idempotencyKey}` |

重试返回的是重试记录 ID，页面继续保留原根任务卡片并刷新根任务，其 status/progress/groups/items 会更新。不要把重试任务 ID 替换为工作台当前组合 ID。生图重试沿用原组合，保持 resultId/index，按钮文案“按原方案重试”，提示可能产生新费用。

## 7. 母版列表、拆解和人物说明

### 7.1 母版列表

列表用 `thumbnailUrl ?? previewUrl`，大图用 previewUrl。缩略图加载失败可回退原图一次，原图也失败则展示占位，避免 onError 循环。

`activeBreakdownTask` 为 null 或 `{id,status,stage,errorCode,errorMessage}`。用它显示拆解中/失败，无需再额外拉 BREAKDOWN 列表补首屏状态。拆解状态发生变化后刷新母版列表/详情。

### 7.2 货篮、宠物、道具

`breakdown.payload.basketContents.hasItems` 为三态：true 有物品、false 明确为空、null 无法判断；旧数据整个 basketContents 可能为 null 或缺失，一律显示“无法判断”，不能用 `!hasItems` 判断空篮。

```ts
const hasItems = payload.basketContents?.hasItems;
const basketLabel = hasItems === true ? '有物品'
  : hasItems === false ? '空篮' : '无法判断';
```

`baskets?: Array<{id,position,hasItems:boolean|null,evidence,items:string[]}>` 按篮子逐项展示。联想维度 `definition.purpose=basket_contents` 时用 basketId 对应具体篮子，不把多篮强行合并。

`pets/props?: Array<{id,description,position}>` 展示“宠物 / 道具”明细。旧数据为空仅表示未记录，可以回退原软特征描述，不写“图片中没有宠物/道具”。无需为展示新字段批量重跑旧图拆解。

| softFeatures key | 中文名称 |
|---|---|
| composition | 构图 |
| sceneLightColor | 场景、光线与色彩 |
| peoplePetsStory | 人物、宠物与叙事 |
| propsOcclusion | 道具与遮挡 |
| graphicsText | 图形与文字 |
| effects | 效果 |
| rendering | 渲染表现 |

### 7.3 人物说明和拆解确认

personMode 为 keep/replace 都展示 personText 输入框；切回 keep 不清空文字。keep 的提示文案可用“可调整服饰、表情和动作，保留人物身份外观”。personText 最多 1000 字。

AI 未复核拆解继续用一次性“已阅读并确认”按钮：`POST /images/:id/acknowledge`，传 `{breakdownId,draftRevision}`，成功后重读草稿。确认针对当前拆解版本，新版本需重新确认；不做可取消确认的开关。

## 8. 配置、限制和生成张数

以 GET `/config` 控制 enabled、capabilities 和 models.ready。保留 refreshGroup、targetedRetry、upload、diverge 能力开关，不硬编码全部开启。

| 删除的旧前端拦截 | 保留的业务规则 |
|---|---|
| 活动任务数 ≥2 拒绝提交 | 具体流程互斥仍以后端为准，如维度刷新期间不能组合 |
| 固定 10MB/25MB 上传上限 | JPEG/PNG/WebP，后端继续校验损坏、动图和多页文件 |
| 4096 长边、16MP、额外最短边阈值 | 不再增加 PRD 建议值作为强制拦截 |
| 每维手写最多 30 项 | 每维所有来源合计最多 300 项 |
| 超过 240 项禁止发散 | 剩余容量不足 30 才禁止发散 |
| 等待提交接口返回余额不足再引导充值 | 当前无余额预检，调用后按实际结算，允许透支 |

config 当前仍返回：联想 10–20 维、每组 30–60 项、自建维度最多 10 个、每维累计 300 项、文字最多 1000 字。自建维度名称按 DTO 仍为 1–60 字。生成张数取 `config.generateCounts`（当前 1/2/4/8）。

不要新增 uploadMaxPixels 配置读取，也不要把字段缺失解释为 0 或用旧限制兜底。清理旧 QUOTA_EXCEEDED →“等待任务完成”的车泰斗专用分支；本次不新增 INSUFFICIENT_CREDITS 提交错误。

张数保存 key：`chetaidou:<userId>:<imageId>:count`。读取后转数字，必须属于 config.generateCounts，否则回退第一个可选值；用户切换张数即保存。不把 count 加到 PUT 草稿里，只有 GENERATE 请求带 count。本期不做跨设备同步。

## 9. 预览墙和下载

结果行新增 `compositionTaskId:string|null`、`summaryCn:string|null`。大图对照直接展示该行 masterImage 和 summaryCn，摘要对应生成这张图时采用的组合。不要用当前草稿或当前组合覆盖历史结果摘要；缺失时显示“暂无修改摘要”，有 compositionTaskId 时可按需读取对应历史组合。

下载推荐最简实现：

1. 带用户认证请求 `GET /results/:resultId/download`。
2. 得到 `{url,filename,expiresAt}` 后，用普通链接跳转到 url。签名已包含附件响应头，浏览器按后端 filename 下载。
3. 直接打开跨域链接不需要前端 fetch CORS；不要依赖跨域 `<a download>` 属性改名，也不要向对象存储发送 Bearer Token。

后端文件名例：`CS1plus_NO7_<taskShortId>_1.png`；上传图无编号用 master，后缀按真实文件格式。前端不再次拼 NO 或强制改成 png。

若沿用 Blob 下载：使用不注入业务 Authorization 的原生 fetch 访问签名 URL，检查 response.ok，用后端 filename 保存，完成后释放 object URL。需当前页面 origin 被桶 CORS 放行；失败提供“直接下载”链接，不悄悄重复下载。签名过期重新调用 download 接口，不能永久缓存 URL。

此前核验的现有 dev2/dev3/uat 等域名已允许 GET/HEAD，`http://localhost:4000` 也已放行。新域名、其他本地端口需要重新核实，最终在实际前端 origin 验收。

## 10. 错误处理建议

错误体通常为 `{statusCode,message,code?,details?,timestamp}`；message 可能为字符串数组，code/details 可能缺失。先处理 HTTP 401/403，再识别业务 code，其余展示后端中文 message。

| 错误/状态 | 前端处理 |
|---|---|
| 401 / 403 | 走现有登录/权限提示，不当模型调用失败重试 |
| SETTINGS_CHANGED / DRAFT_CONFLICT | 保留输入，重读草稿，合并或用户确认 |
| SOURCE_VERSION_CHANGED | 重新读取母版/草稿/组合，展示具体原因；可能是版本变化或刷新尚未完成 |
| BREAKDOWN_UNCONFIRMED | 引导确认当前拆解版本 |
| DIMENSION_CAPACITY_EXCEEDED | 提示删减当前维度方案 |
| IDEMPOTENCY_CONFLICT | 同一键被用于不同请求，停止自动重发；新操作应生成新键 |
| MODEL_NOT_READY | 提示模型暂不可用，不重建任务循环尝试 |
| REQUIRED_DIMENSION_MISSING | 提示缺少有效联想维度，按失败组重试或重新联想 |
| FILE_UNSUPPORTED / INVALID_INPUT | 展示后端校验原因 |
| UNKNOWN / CALL_STATUS_UNKNOWN / WAITING_RECONCILIATION | 待核对，保留任务，不自动重新生成 |
| SETTLING / BILLING_PENDING / DELIVERY_PENDING | 正在结算/交付，继续跟踪，不当作可重试失败 |
| 其他 400/409 或无 code | 展示 message，需要时刷新关联对象，不全部归类为余额或并发不足 |

## 11. 与原联调问题逐项对应

### 第一部分：后端补充问题

| 原编号 | 前端是否修改 | 本次做法 / 对应章节 |
|---|---|---|
| P0-1 | 修改 | 新权限 key、删除白名单（2.1） |
| P0-2 | 修改 | 冻结 conflict 结构与提交规则（4） |
| P0-3 | 修改 | 草稿指针恢复最新组合轮次（3） |
| P0-4 | 修改旧提示，不新增余额预检 | 删除活动任务数/余额不足旧假设（8、10） |
| P1-1 | 修改 | target 恢复维度任务状态（6.1） |
| P1-2 | 修改 | 使用服务端 ideationStale（3.5） |
| P1-3 | 核对现有实现 | 重试后刷新原根任务，不新增重复卡片（6.4） |
| P1-4 | 修改 | 先保存拿稳定 ID/key；AI 来源；删除历史无需前端上传（5） |
| P1-5 | 修改 | activeBreakdownTask 和 thumbnailUrl（7.1） |
| P1-6 | 修改 | 三态货篮、多篮、宠物/道具、七维中文名（7.2） |
| P1-7 | 修改 | 展示每张结果的历史摘要（9） |
| P1-8 | 修改并验收 | 后端文件名、签名附件下载/Blob（9） |
| P2-1 | 修改 | updatedAt + 请求序号防止旧快照覆盖（6.2） |
| P2-2 | 修改 | 多状态一次查询（6.2） |
| P2-3 | 修改 | 使用任务自身的母版标题/编号（6.1） |
| P2-4 | 不新增配置，删除旧拦截 | 不再限制 16MP（8） |
| P2-5 | 核对现有实现 | 默认草稿 revision=0；用产出任务取组；按状态控制动作（3.1、5.5、6） |

### 第二部分：PRD / 原型差异

| 原编号 | 前端是否修改 | 本次决定 |
|---|---|---|
| 1 人物说明 | 修改 | keep 仍展示并保留 personText（7.3） |
| 2 并发限制 | 修改 | 删除活动任务数 ≥2 拦截（8） |
| 3 维度刷新 | 保留 | 能力开关和换一批仍有效，更新组版本（5.5） |
| 4 失败图片重试 | 保留 | 按原方案定向重试，提示新费用（6.4） |
| 5 取消 | 调整文案/核对行为 | 只取消未开始的图片（6.3） |
| 6 任务状态 | 保留 | 七态，待核对不映射为失败（6） |
| 7 上传限制 | 修改 | 删除大小/边长/像素拦截，保留格式校验（8） |
| 8 发散门槛 | 保留 | 剩余容量 ≥30，不加 240 门槛（5.2） |
| 9 手写数量 | 修改 | 删除手写 30 项限制，保留每维总容量（8） |
| 10 发散应用 | 核对并补充 | 自动写回后重读草稿，不本地重复追加；409 再确认（5.3） |
| 11 放弃结果 | 修改 | 调 discard，刷新后也保持放弃（5.3） |
| 12 冲突答案保存 | 修改 | 未提交答案按问题版本存本地；不加后端草稿字段（4.2） |
| 13 张数保存 | 修改 | 本地保存并用 config 校验；不加后端字段（8） |
| 14 组合过期 | 保留并核对 | 后端指针/isStale + 本地未保存状态（3.4） |
| 15 草稿冲突 | 保留并补充字段 | 沿用三方合并，读取 currentDraft，禁止静默覆盖（3.6） |
| 16 拆解确认 | 保留 | 一次性版本确认，不提供撤销（7.3） |
| 17 下载文件名 | 核对 | 使用后端 filename，已带 NO（9） |

## 12. 联调验收清单

1. **权限**：有新节点或父级权限可访问；无权限账号收到 403；移除 RouteGuard 白名单后仍正常。
2. **组合恢复**：排队、运行、待回答、阻断、失败时刷新页面，都恢复草稿指向的当前轮次；回答一轮后刷新显示新轮次。
3. **幂等**：模拟请求超时，原请求原键重发只产生一个任务；前端能兼容 taskId/id 响应。
4. **过期**：组合运行中修改并保存草稿，旧任务晚成功后不能恢复成当前可生图组合；刷新后仍正确。
5. **联想过期**：修改设置后旧方案保留但不可用于组合；纯自建维度场景不被无关旧联想拦住。
6. **冲突问答**：全部非阻断问题一次提交；阻断问题不能作答；本地只恢复同 ID/版本答案。
7. **稳定 ID**：新维度/方案保存后拿到真实 ID/key；立即选中并保存成功；刷新不丢选择。
8. **来源标签**：AI 发散后修改其他字段并保存，刷新后 AI 标签仍在；手写项不冒充 AI。
9. **发散应用**：无草稿变化时自动应用一次；期间改草稿时保留产物，用户确认后应用；重复应用不重复追加。
10. **放弃**：未应用产物放弃后刷新不再提示；已应用产物只能从草稿删除；不出现退款承诺。
11. **换一批**：成功后 groupId/选择引用更新；恢复页面能读刷新组；刷新期间禁组合和生图。
12. **重试/取消**：只重试 FAILED 目标，根任务进度更新、resultId/index 不变；取消不把已开始图片标为取消；UNKNOWN 不可重试。
13. **任务轮询**：旧响应晚到不覆盖新状态；任务状态相同但子项变化仍更新；多状态 total 与筛选一致。
14. **拆解展示**：null/缺失货篮信息显示未知；多篮分别展示；旧宠物/道具空数据不被解释成不存在。
15. **表单**：keep 人物说明切换不丢；手写第 31 项可保存；发散 270/271 边界正确；旧上传像素限制已移除。
16. **预览墙**：历史图片摘要不随当前草稿变化；缩略图和失败占位正常；刷新后张数保留并符合 config。
17. **下载**：在实际部署 origin 验证附件文件名带 NO、扩展名正确；对象存储请求无 Bearer；过期 URL 可重新获取。
18. **并发编辑**：两标签页修改同一草稿，旧 revision 收到 409 后本地输入不丢，用户确认后再保存，不静默覆盖新版本。

验证会真正调用模型的场景时，按实际费用结算；纯展示、权限、草稿保存和历史结果恢复可先完成，不必为了验证新展示字段重跑全部旧任务。

## 13. 后端实现位置（供联调定位）

- 路由：`src/chetaidou/chetaidou.controller.ts`
- 入参：`src/chetaidou/dto/chetaidou.dto.ts`
- 草稿、任务投影、组合、下载：`src/chetaidou/chetaidou.service.ts`
- 自建维度规范化、发散应用：`src/chetaidou/chetaidou-draft.ts`
- 拆解、冲突和选项结构：`src/chetaidou/chetaidou.schemas.ts`
- 联调回归用例：`src/chetaidou/chetaidou-integration.spec.ts`

本指南是本次前端变更说明，不替代原有全部接口文档。发现旧文档的活动任务数、上传尺寸、手写 30 项或权限 key 与本文冲突时，以本次代码契约为准。
