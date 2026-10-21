# 车泰斗历史记录规则前端联调文档

更新日期：2026-10-15。适用分支：`lsx/feat-chetaidou-workflow`。面向图片创作车泰斗的前端开发及前端 AI。

本次规则：**修改出图要求并保存即创建历史；尚未联想或组织前继续修改，只更新该条。新要求首次联想、首次组织、问答和出图关联当前记录；再次联想或再次组织则另建记录并继承当前上下文。** 历史创建和关联由后端决定，前端按接口返回的 Adjustment ID 展示。沿用现有接口和字段，不增加客户端的“新建历史”参数。

## 1 新增和复用规则

Adjustment 是一条调整历史，Task 是记录内的一次执行。复用表示更新同一条历史的当前设置、选择及任务指针，并继续关联执行任务；各次任务的冻结输入、组合产物和生成图片批次保留，不把旧产物覆盖成新产物。

下表默认用户在当前活动记录内操作；restore 得到的工作副本按后面的独立规则处理。出图要求指 settings.site/textMode/personMode/personText/customText；模型和数量范围不属于出图要求。

| 操作 | 是否新增历史 | 后续归属 |
| --- | --- | --- |
| 新建空白调整、保存未改变要求的默认表单 | 否 | 当前工作草稿 |
| 首次修改出图要求并保存 | 是 | 立即创建记录，不等模型任务提交 |
| 当前已有联想或组织，再修改出图要求并保存 | 是 | 创建下一条，原记录保留 |
| 新要求尚未提交联想或组织，反复修改并保存 | 否 | 持续更新刚创建的记录 |
| 相同要求重复保存 | 否 | 不重复新增 |
| 新要求的首次 IDEATION | 否 | 关联保存要求时创建的记录 |
| 当前要求再次 IDEATION，包括继承过联想的记录 | 是 | 创建下一轮；保留原记录，当前草稿开始新联想 |
| 当前轮首次 COMPOSE | 否 | 关联当前最新记录 |
| 本轮已组织后再次 COMPOSE，包含更换所选方案后组织 | 是 | 继承当前要求、联想组/全部选项、已选方案、自建维度和来源，再创建新组合 |
| 无历史时首次直接 IDEATION/COMPOSE/DIVERGE | 是 | 兜底创建记录 |
| 组织前保存所选方案、自建维度或执行参数 | 否 | 更新当前记录 |
| 组织后仅修改所选方案或自建维度并保存 | 否 | 保存独立工作副本，不覆盖原历史；再次组织时创建新记录 |
| 活动记录内 REFRESH_GROUP 或 DIVERGE | 否 | 复用当前记录 |
| 当前组合的冲突问答 | 否 | 新建 COMPOSE 任务，历史不变 |
| GENERATE 或基于有效提示词多批出图 | 否 | 生成任务及图片批次关联当前记录 |
| retry 失败重试、同请求原幂等键重发 | 否 | 不重复新增历史 |
| 读取、reset、restore、下载图片 | 否 | 读取或切换工作副本 |

“已联想/组织”以任务已经提交为准，排队、运行、失败、取消都算，不能等成功后才冻结历史。新要求会清空当前联想和组合指针，已有组及选择保留；因此新要求首次联想可复用该记录。重新组织得到的新记录会继承当前要求的联想来源，之后再点联想属于“重新联想”，不能因为新记录自己没有 IDEATION 任务就当作首次。

“再次组织”不能只看草稿 activeCompositionTaskId：换选项可能清空该指针，后端仍按来源和已有 COMPOSE 任务识别。重新组织会保留旧记录原来的选择与提示词；新记录使用这次修改后的选择，已有组及选项引用不可变版本，不重新调用联想。

发散提交后若又提交了组织或冲突答案，晚到的发散结果不自动覆盖当前草稿或历史状态；尚未联想/组织的记录继续修改要求时，旧发散结果也不自动套用新要求。产物仍保留，前端按 canApply 提供手动应用或放弃。手动应用会使当前组合失效。已有组合后主动发散、期间组合和要求未变时，仍按原规则自动应用。无 Adjustment 归属的旧组合，首次提交冲突答案补建记录；后续问答和出图复用，同键重放不重复创建。

### 从历史恢复后的规则

restore 本身不创建历史、不修改记录内容，但按记录是否已联想/组织返回不同归属：

| 恢复的记录 B | 返回的草稿指针 | 恢复后继续操作 |
| --- | --- | --- |
| 尚未提交联想或组织，也未继承其任务指针 | activeAdjustmentId=B，restoredFromAdjustmentId=null | 继续修改要求保存只更新 B；首次联想、首次组织关联 B，不额外新增 |
| 已提交过联想/组织，或继承其任务指针 | activeAdjustmentId=null，restoredFromAdjustmentId=B | 使用工作副本；实际修改要求保存即新建，其他文本任务/答案/手动应用时分叉；未修改有效 READY 组合直接出图仍归 B |

任务失败、取消或组合指针已清空，不会让已执行记录重新变成未执行记录。两类 restore 都更换 workspaceId 并递增草稿 revision，前端必须使用完整响应，不自行设置上述指针。

修改要求保存后，可以直接 COMPOSE、REFRESH_GROUP 或 DIVERGE，不强制先联想；任务关联已经保存的记录，不额外新增。仅发散/刷新而尚未联想或组织时，要求继续修改仍更新该条，但旧任务回包不能覆盖新要求。

记录创建节点为要求保存成功，或没有记录时首次任务提交成功；尚未执行任何模型任务的记录也会出现在列表，tasks 可以为空。没有新增 Adjustment.status，前端可显示“尚未联想/组织”，不能因为任务为空而过滤掉记录。

## 2 连续操作示例

已有已执行历史 A：

| 步骤 | 操作 | 历史列表 |
| --- | --- | --- |
| 1 | 修改要求并保存 | A、B；B.parentAdjustmentId=A |
| 2 | 尚未联想或组织，继续修改要求保存 | A、B，只更新 B |
| 3 | 新要求首次联想 | A、B，联想任务关联 B |
| 4 | 选择方案并保存、首次组织 | A、B，组织任务关联 B |
| 5 | 冲突问答、多批出图 | A、B |
| 6 | 再次组织，或换选项保存后再次组织 | A、B、C；C 继承 B 的要求、联想组/选项和本次选择，B 保留原选择/提示词 |
| 7 | C 中再点重新联想 | A、B、C、D；D.parentAdjustmentId=C，沿用当前要求 |
| 8 | D 联想完成，选方案、首次组织及出图 | A、B、C、D |

若步骤 3 跳过联想，直接首次组织，继续关联 B；不因跳过联想额外新增记录。新要求未联想/组织前的要求编辑可以更新 B，一旦已提交其中任一种操作，再修改要求就新增下一条。

## 3 接口与鉴权

所有请求携带 `Authorization: Bearer <token>`；需要权限 `tool.ai_creative_studio.chetaidou`。路径包含全局 `/api` 前缀，无 URI 版本段。请求体使用 JSON；全局校验启用 whitelist 和 transform，不要向 DTO 提交客户端自行推断的历史 ID 或任务指针。

| 方法 | 完整路径 | 用途 |
| --- | --- | --- |
| GET | `/api/chetaidou/images/:imageId/draft` | 当前草稿及工作区令牌 |
| PUT | `/api/chetaidou/images/:imageId/draft` | 保存完整表单 |
| POST | `/api/chetaidou/images/:imageId/draft/reset` | 创建空白工作副本，HTTP 200 |
| GET | `/api/chetaidou/images/:imageId/adjustments?page=1&pageSize=20` | 历史分页列表 |
| GET | `/api/chetaidou/images/:imageId/adjustments/:adjustmentId` | 历史状态及关联 tasks |
| POST | `/api/chetaidou/images/:imageId/adjustments/:adjustmentId/restore` | 恢复历史，HTTP 200 |
| POST | `/api/chetaidou/tasks` | 提交联想、组织、刷新、发散或出图，HTTP 202 |
| GET | `/api/chetaidou/tasks/:taskId` | 任务状态及归属 |
| GET | `/api/chetaidou/tasks/:taskId/output` | 业务产物，包括 GENERATE 生图项 |
| GET | `/api/chetaidou/tasks/:taskId/groups/:groupId` | 组方案正文 |
| GET | `/api/chetaidou/compositions/:compositionTaskId` | 组合产物及 isStale |
| POST | `/api/chetaidou/compositions/:compositionTaskId/answers` | 冲突问答，HTTP 202 |
| POST | `/api/chetaidou/tasks/:taskId/retry` | 失败任务重试，HTTP 201 |
| POST | `/api/chetaidou/tasks/:taskId/apply` | 手动应用有效刷新/发散产物，HTTP 201 |
| POST | `/api/chetaidou/tasks/:taskId/discard` | 放弃未应用的发散产物，HTTP 200 |

`imageId` 是母版图 ID；`adjustmentId` 是历史 ID；`compositionTaskId` 是 COMPOSE 根任务 ID。三个 ID 不可混用。

## 4 草稿字段与提交顺序

| 字段 | 含义 | 前端使用方式 |
| --- | --- | --- |
| `workspaceId` | 当前工作区 UUID | 保存、reset、restore、任务、答案、apply 使用当前令牌 |
| 草稿 `revision` | 当前草稿版本 | 保存、reset、restore 传 revision；任务、答案、apply 传 draftRevision |
| `activeAdjustmentId` | 当前正在写入的历史 ID，可空 | 非空时用于定位当前活动记录 |
| `restoredFromAdjustmentId` | 工作副本的来源历史 ID，可空 | 表示来源，不表示修改已写回来源 |
| `activeIdeationTaskId` | 当前要求的联想任务 ID，可空 | 新要求保存后为空；已有组仍按 activeGroups.producerTaskId 加载 |
| `activeCompositionTaskId` | 当前组合任务 ID，可空 | 用于读取组合、回答冲突和提交生图 |
| `activeGroups` | 当前有效组及 producerTaskId | 按每组自己的 producerTaskId/groupId 获取方案 |
| `pendingRefreshTaskId` | 当前刷新占位，可空 | 随最新草稿同步，不沿用旧工作区占位 |

历史详情自身也有 `revision`，它是历史状态版本，**不能当作草稿版本提交**。工作区令牌改变也不等于新增历史：保存要求、reset 和 restore 都可能更换令牌而不新增记录。

### 保存要求

`PUT /api/chetaidou/images/19/draft` 示例：

```json
{
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "revision": 6,
  "settings": {
    "site": "original",
    "textMode": "keep",
    "personMode": "keep",
    "personText": "",
    "customText": "使用冬季氛围"
  },
  "selections": [],
  "customDimensions": []
}
```

实际发送完整当前表单，保留用户已有模型、数量配置、选择及自建维度；示例空数组表示用户当前没有这些内容，不能固定发送空数组清掉已有选择。

已有历史后修改要求的响应关键字段示例，其他草稿字段省略：

```json
{
  "workspaceId": "ab08633c-9812-43b7-94ed-17b9c2916389",
  "revision": 7,
  "activeAdjustmentId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "restoredFromAdjustmentId": null,
  "activeIdeationTaskId": null,
  "activeCompositionTaskId": null,
  "pendingRefreshTaskId": null
}
```

此时 B 已保存，可通过历史列表和详情恢复；旧组合失效，当前联想指针清空，已有组和选择仍保留。前端用完整保存响应替换本地草稿，立即刷新历史列表。若 B 尚未提交联想或组织，继续修改保存只更新 B，ID 不变；workspaceId/revision 仍可能改变，始终使用完整响应。**不要自动 restore 来源历史，也不要等任务提交后才显示 B。**

只修改选项/自建维度的情况不同：如果当前记录已组织，保存返回 activeAdjustmentId=null、restoredFromAdjustmentId=原记录 ID，形成独立工作副本，原历史的选择不变；随后普通 COMPOSE 才新建下一条。切走前该副本没有独立历史，需要提示用户。

### 提交联想和组织

必须先等待保存成功，再提交任务。`POST /api/chetaidou/tasks`：

```json
{
  "type": "IDEATION",
  "imageId": 19,
  "workspaceId": "ab08633c-9812-43b7-94ed-17b9c2916389",
  "draftRevision": 7,
  "idempotencyKey": "b2c3d4e5-1111-4222-8333-444455556666"
}
```

首次提交响应示例：

```json
{
  "taskId": "e73de9e8-6416-4c95-9a55-9453b344ff89",
  "status": "QUEUED"
}
```

保存要求后 B 已存在，首次 IDEATION 继续关联 B。成功提交后 GET draft 读取最新令牌、版本和历史 ID，再刷新 adjustments 列表。等待有效组，选择并保存后提交 type="COMPOSE"，首次组织继续关联 B。后续重新联想才新增记录；新联想启动会清空当前草稿旧组引用及选择，原历史的组与选择保持原样。新请求使用最新令牌/版本和新幂等键。

第一次创建返回 `taskId`，同键重放可能返回任务详情的 `id`，客户端统一取 `response.taskId ?? response.id`。不能假设任务创建响应一定包含 adjustmentId，应从最新草稿或任务详情取得归属。

### 问答和生图

问答走 `POST /api/chetaidou/compositions/:compositionTaskId/answers`，请求示例：

```json
{
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 10,
  "idempotencyKey": "ee84b5db-7a29-4e34-aa61-56d33997cd27",
  "answers": [
    { "conflictId": "c1", "questionVersion": 1, "choiceId": "keep" }
  ]
}
```

示例的令牌、版本及问题字段均需替换为当前服务端数据，一次提交全部当前非阻断问题答案。成功后读取最新草稿，跟随新的组合任务指针；不能把问答改成普通 COMPOSE，也不要发送内部操作类型 ANSWERS。

组合任务成功、产物 `output.status="READY"` 且组合未失效时，提交 GENERATE：

```json
{
  "type": "GENERATE",
  "imageId": 19,
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 11,
  "idempotencyKey": "44d9b227-cdcb-443b-bd53-4b488a21d401",
  "compositionTaskId": "e73de9e8-6416-4c95-9a55-9453b344ff89",
  "count": 1,
  "aspectRatio": "1:1"
}
```

`compositionTaskId` 必须替换为最新有效 COMPOSE 根任务 ID，不能使用联想任务 ID。count 支持 1/2/4/8；比例和模型能力校验沿用已有生图契约。生图首次响应包含 taskId、imageGenJobId、status 和 items，关联记录仍保持同一个 ID。

### 历史记录的资料版本

要求保存时，state.facts/state.breakdown 先记录当时的版本引用。随后提交普通 IDEATION 或 COMPOSE（包含首次复用当前记录），同一事务将这两个引用同步为该任务 snapshot 的实际版本，不重复创建历史。历史 state 表示当前记录的执行上下文；每次任务自己的冻结 snapshot 保留，不随资料发布或后续任务改写。读取草稿、恢复历史、普通表单保存和重试不会把已有任务的版本切换到最新资料。

### 恢复和失败重试

reset 或 restore 请求携带**切换前当前草稿**的 `workspaceId` 和 `revision`，成功后完整替换本地草稿。历史 restore 接口只接受这些工作区字段，不提交从前端拼装的组正文或历史 state。

失败重试使用 `POST /api/chetaidou/tasks/:taskId/retry`，必传新的 UUID `idempotencyKey`；按既有契约可传 draftRevision、失败维度 groupIds 或失败图片 resultIds。RetryTaskDto 不要求 workspaceId，不要套用普通任务的必填结构。调用 retry 复用原历史，点击“重新组织”则提交新的普通 COMPOSE，按规则另存记录。

## 5 前端需要调整的地方

1. **历史列表按记录渲染。** 使用 adjustments 的 `{total,page,pageSize,items}`，以 `item.id` 为 key；total 按历史条数计算。一个记录内的联想、问答、生成 Task 不拆成多个历史行，也不根据时间戳自行合并。
2. **复用时刷新同一行。** 当前记录的 state 和 updatedAt 可能更新；详情 `tasks` 保留各次执行。接口没有独立的 Adjustment.status 字段，阶段展示需要结合关联任务状态，不能把 Task ID 当历史 ID。
3. **保存要求后立即刷新历史。** 首次修改或已执行后的修改会新增，未联想/组织前继续编辑会更新同一行。activeAdjustmentId 非空时定位已保存记录，也包括恢复的未执行记录；activeAdjustmentId=null 且存在来源 ID 时为已执行历史的恢复或选项编辑副本，不反写来源。
4. **串行保存和提交。** 保存成功后再联想、组织或出图。保存/reset/restore 用完整响应更新草稿；任务、问答、apply、重试提交成功后重新 GET draft，并刷新历史列表。使用服务端版本，不在本地自行加一。
5. **明确按钮入口。** 失败重试走 retry；重新组织走普通 COMPOSE；冲突问答走 answers。为每次新操作分配新幂等键，网络重发保留原幂等键、令牌、版本及完整请求体。
6. **隔离旧页面及旧回包。** 切换工作区时停止旧工作区自动保存；旧任务轮询可继续更新任务展示，但不能覆盖当前编辑器。恢复历史后再收到原任务的新结果，需要读取历史详情；用户有编辑时不自动再次 restore。
7. **加载恢复出的真实组版本。** 按 activeGroups 内每组的 producerTaskId/groupId 获取方案，不把所有组都挂到 activeIdeationTaskId。只有有效成功组的选项可选。
8. **按实际归属提示切换风险。** 已保存新要求即有历史，即使尚未任务也能恢复。未保存的输入、已执行历史恢复后尚未形成新记录的编辑，以及组织后只换选项但尚未重新组织的副本可能没有独立历史，切走前提示可能丢失的修改。

## 6 错误处理

错误响应按当前全局过滤器返回，业务 code 在顶层：

```json
{
  "statusCode": 409,
  "code": "SETTINGS_CHANGED",
  "message": "当前调整已变化，请重新读取草稿后重试",
  "timestamp": "2026-10-15T08:00:00.000Z"
}
```

| 状态或业务码 | 前端处理 |
| --- | --- |
| 400 参数校验失败 | 展示中文 message，检查 UUID、版本和任务类型等字段 |
| 409 SETTINGS_CHANGED | 保留未提交编辑，重新 GET draft；令牌或内容变化时由用户确认如何继续，不自动用旧请求覆盖，也不强制重做联想 |
| 409 IDEMPOTENCY_CONFLICT | 同键请求内容不同；相同请求重发保留原完整体，用户发起新操作使用新 UUID |
| 400 NEEDS_RESOLUTION | 当前组合不能生图，先处理冲突并取得 READY 组合 |
| 401 或 403 | 沿用登录失效及权限不足处理 |
| 404 | 来源记录、任务或母版不可访问，展示接口提示 |

轮询任务的 errorCode/errorMessage 是任务字段，不等于 HTTP 错误响应。WAITING_RECONCILIATION 或未知执行结果不能直接当作可重试失败；部分成功联想可按现有 allowPartialIdeation 契约使用有效组，详细规则见完整联调文档。

## 7 前端验收用例

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| H01 | 新建空白调整，保存默认表单 | 不新增历史 |
| H02 | 首次修改要求并保存 | 立即出现 A，tasks 可为空 |
| H03 | A 尚未联想/组织，反复修改保存 | 同一个 A，total 不变，恢复可见最新要求 |
| H04 | A 新要求首次联想 → 选方案 → 首次组织 → 问答 → 多批出图 | 全部任务归 A，不额外新增 |
| H05 | A 已执行，修改要求并保存 | 立即新增 B，A 保留；B 首次联想/组织复用 |
| H06 | A 已联想 → 再次联想 | 新增 B，沿用当前要求；旧组及选择保留在 A，新轮草稿清空旧选择 |
| H07 | A 已组织 → 再次组织 | 新增 B，继承要求、联想内容、全部选项及选择，A 提示词保留 |
| H08 | A 已组织 → 换选项保存 → 再次组织 | 保存不覆盖 A；组织时新建 B，用新选择；A 原选择不变 |
| H09 | B 由重新组织产生且继承 A 联想 → 重新联想 | 新增 C，不能把继承联想当作尚未联想 |
| H10 | 新要求保存后跳过联想，直接组织 | 复用保存时创建的记录 |
| H11 | 已提交排队/失败/取消的联想或组织，再修改要求 | 新增下一条，不覆盖已提交记录 |
| H12 | 同键网络重发、失败任务 retry | 不重复新增历史或扣费 |
| H13 | 已执行记录的读取、restore、未修改 READY 组合出图 | 不新增；恢复后实际修改要求保存则新建 |
| H14 | 要求保存后刷新页面、切换并恢复 | 尚未执行的记录也可恢复完整表单 |
| H15 | 旧联想/刷新/组合在修改要求后晚完成 | 更新其所属旧历史，不覆盖新要求记录和草稿 |
| H16 | 发散先提交，随后新组合/答案或要求编辑，再收到发散结果 | 不覆盖当前组合或新要求，产物可手动应用或放弃 |
| H17 | 已有组合后主动发散，组合和要求未变 | 仍可自动应用 |
| H18 | 旧组合无 adjustmentId，首次提交答案后出图 | 答案补建一条历史，后续出图复用 |
| H19 | 旧草稿版本保存/任务提交，或历史创建写入失败 | 409 或失败；无多余历史，原草稿与来源不被部分覆盖 |
| H20 | 未执行 B 切走并恢复，改要求保存、首次联想或首次组织 | 都复用 B，total 不增加；restore 不改 B 内容，返回 activeAdjustmentId=B |
| H21 | 联想/组织失败且指针已清空，恢复后改要求保存 | 仍创建下一条，失败记录 B 保留 |
| H22 | 保存 B 后发布新版事实卡/拆解，再首次联想或组织 | 复用 B，state 资料引用同步实际任务快照版本；任务或历史写失败则整体回滚 |

现有历史不合并、不回填；本次规则不改变实际模型调用及计费。后端 18 套 536 项车泰斗及回执回归通过；真实前端联调及真实生图需按上述用例验收。

完整模块契约见 [车泰斗流程优化前端联调文档](./README.workflow-optimization.integration.md)，后端验证记录见 [开发与测试台账](./README.workflow-optimization.tasks.md)。
