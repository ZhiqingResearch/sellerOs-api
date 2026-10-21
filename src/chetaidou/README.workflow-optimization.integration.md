# 车泰斗流程优化前端联调文档

更新日期：2026-10-15。对应分支：`lsx/feat-chetaidou-workflow`。后端代码、本地回归和 HTTP 契约测试已完成。按用户本轮要求，SQL 由用户自行执行；正式前端联调和真实生图不执行，仅交付接入文档。

所有车泰斗接口以 `/api/chetaidou` 开头，需要 `Authorization: Bearer <token>` 及权限 `tool.ai_creative_studio.chetaidou`。模型目录接口为 `/api/ai-models`，使用同一 JWT。业务状态保持大写；原型适配层如使用小写，继续在适配层转换。

## 1 前端本轮必须调整

| 项目 | 接入行为 |
| --- | --- |
| 上传后联想 | 拆解已成功且非 INVALID 即可提交；AI_UNREVIEWED 无需 acknowledge，不显示强制已读确认 |
| 拆解失败 | FAILED 展示接口的 `errorMessage`：`与母版差异太大`；待核对、取消、上传参数错误按其真实状态处理 |
| 提示词 | 隐藏提示词展示 UI；保留组合、冲突问答与生图操作 |
| 新建调整 | 调用服务端 reset，使用返回的完整默认草稿，不自行复制上一轮设置 |
| 调整历史 | 以 Adjustment 列表为准；保存修改后的要求即建历史，尚未联想/组织前继续修改只更新；首次联想/组织复用，重复执行分叉并继承上下文 |
| 恢复历史 | 调用 restore；未联想/组织记录继续更新原记录，已执行记录恢复为独立工作副本 |
| 修改后继续 | 保存修改后可直接 COMPOSE、REFRESH_GROUP，不强制重新联想 |
| 草稿写入 | 保存、reset、restore 带 `workspaceId + revision`；任务、答案、apply 带 `workspaceId + draftRevision` |
| 生图模型 | 读取图片目录，用 publicId 传 `imageModel`；推荐标记不自动替换已有默认模型 |
| 列表筛选 | 任务列表和预览墙支持 `site + imageId`；切换筛选后回到第一页 |

### 2026-10-13 剩余 bug 修复后的前端待办

本次后端修复两项：有调整历史的 IDEATION 每个维度成功时，在同一事务中发布有效组；首次直接 DIVERGE 也创建调整历史。批次扩展、逐维扩展、定向重试和原回执恢复共用发布逻辑。新增有效组时递增草稿 revision，重复回执及收尾不重复递增；有效组保持原维度顺序，不覆盖已刷新的组版本。无新增接口、数据库字段或状态，历史空 adjustmentId 不回填。

1. **成功维度立即可选。** 任务轮询看到新增 SUCCEEDED 维度，且其 groupId 不在本地 activeGroupRefs 时，重新 GET `/api/chetaidou/images/:id/draft`。只允许选择 SUCCEEDED 且在有效组内的维度，不用整轮任务状态置灰所有选项。每次提交任务后也重新读取草稿，使用新的 workspaceId/revision，首次直接发散同样如此。
2. **保存与提交使用最新版本。** 异步维度发布可能递增草稿 revision。遇到 HTTP 409、code=`SETTINGS_CHANGED` 时读取最新草稿，保留用户尚未保存的选择和自建维度，并只合并仍有效的选择；工作区令牌改变时提示用户重新确认，不能把旧工作区编辑自动覆盖到新工作区。历史详情 revision 不能当作草稿 revision 使用。
3. **待核对允许使用成功结果。** WAITING_RECONCILIATION/PARTIAL 时保留成功维度的保存、换一批及组织按钮；用户确认仅用已完成维度后，提交 COMPOSE 带 allowPartialIdeation=true。定向重试只传 FAILED 维度的 groupIds，UNKNOWN/RUNNING 不可重试；仍处理正常的模型、版本和刷新占位校验失败。
4. **任务中心按历史定位。** 点“打开母版”先读该母版草稿。任务 adjustmentId 与 activeAdjustmentId/restoredFromAdjustmentId 任一一致时直接进入；都不一致时确认后 POST `/api/chetaidou/images/:id/adjustments/:adjustmentId/restore`，请求带切换前草稿的 workspaceId/revision，用响应替换当前工作副本。按 activeGroups 中的 producerTaskId/groupId 逐组获取方案。旧任务 adjustmentId=null 时只打开母版，提示“该任务早于调整历史功能，无法定位到对应记录”。
5. **执行中历史继续读取历史详情。** restore 会更换令牌，旧任务新成功的维度只补到所属历史，之后只 GET draft 不能保证读到新增结果。继续 GET `/api/chetaidou/images/:id/adjustments/:adjustmentId` 观察任务及记录 revision；记录更新且页面未编辑、当前草稿令牌/版本仍匹配时，可再次 restore 加载最新内容。一旦恢复后有未保存或已保存的编辑，禁止自动再次 restore，提示“原任务已有新结果，重新加载会覆盖当前编辑”。联想没有单独的 apply 接口，不要自动调用发散/刷新任务的 apply 来加载联想。
6. **切换前说明覆盖范围。** 保存新要求即有独立历史，未执行模型任务也能恢复；不要过滤 tasks 为空的记录。未保存的输入、恢复后仅改选项，以及已组织后换选项但未重新组织的工作副本可能没有独立历史。切换前只提示这些尚未形成记录的编辑会丢失；已经保存到 activeAdjustmentId 的内容可从历史恢复。

验收：同一母版 A/B 任务分别打开对应记录；联想中途成功一维即能选择、保存和组织；待核对/失败记录打开后可见本轮任务和失败信息；恢复执行中记录后能加载迟到成功维度且不自动覆盖用户编辑；同一历史不重复 restore；旧空 ID 任务正常提示。

超时提示沿用现有语义：单次文本调用默认等待 5 分钟，明确超时为 FAILED，可手动重试；联想中断检测默认 45 分钟（可通过 CHETAIDOU_IDEATION_DEADLINE_MS 调整），只将不在本进程执行、长时间未更新的 RUNNING 任务转待核对，不是 45 分钟后全部 FAILED。UNKNOWN 保留核对，不提示其必然在后台执行，也不提示用户直接重试该维度。

## 2 工作区令牌与版本

先调用 `GET /api/chetaidou/images/:id/draft`。新增字段：

```json
{
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "revision": 3,
  "activeAdjustmentId": null,
  "restoredFromAdjustmentId": null,
  "settings": {
    "site": "original",
    "textMode": "keep",
    "personMode": "keep",
    "personText": "",
    "customText": ""
  },
  "selections": [],
  "customDimensions": [],
  "activeIdeationTaskId": null,
  "activeCompositionTaskId": null,
  "activeGroupRefs": [],
  "activeGroups": [],
  "pendingRefreshTaskId": null,
  "ideationStale": false,
  "staleReason": null
}
```

`workspaceId` 是工作区令牌，草稿 revision 与历史详情 revision 独立。reset/restore、更改要求、已组织后修改选项及实际分叉可能更换令牌，不能用令牌变化推断是否新增。新要求首次 IDEATION/COMPOSE 复用保存时的记录及令牌；再次 IDEATION、再次 COMPOSE 才分叉。重新组织会继承当前要求的联想来源，再次联想仍算重新执行。冲突问答与出图继续复用；异步结果可能递增草稿版本。

保存/reset/restore 用响应完整替换本地草稿。任务、答案、apply、取消和重试成功后重新 GET draft；关联任务完成后也重新读取。不要仅根据提交前的 revision 在本地加一。切换工作区前应停止旧页面的自动保存，旧任务轮询继续用于任务列表，其回包不能覆盖当前编辑器。

HTTP 409 的业务码 `SETTINGS_CHANGED` 表示工作区或草稿版本已变化：保留本地未提交内容，重新读取服务器草稿，再由当前操作决定如何合并或重新保存。不要用旧令牌自动覆盖，不要因此强制重做联想。全局异常过滤器的 `message` 可能承载业务对象，沿用已有错误解包方式。

同一提交重发必须保留原 UUID 幂等键、令牌、版本及完整请求体；修改内容或模型时使用新的幂等键。任务创建首次返回 `taskId`，已存在任务重放可能返回详情的 `id`；统一读取 `response.taskId ?? response.id`。

## 3 保存与新建

`PUT /api/chetaidou/images/:id/draft`：

```json
{
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "revision": 3,
  "settings": {
    "site": "amazon_de",
    "textMode": "keep",
    "personMode": "keep",
    "personText": "",
    "customText": "使用冬季氛围",
    "model": "ZQ-Think-Lite",
    "dimensionCountRange": { "min": 10, "max": 20 },
    "optionCountRange": { "min": 30, "max": 60 }
  },
  "selections": [],
  "customDimensions": []
}
```

保存仍是完整表单提交；保留现有自建维度 ID 和选项 key，新增项缺 ID 时由后端分配。选择仍用 `{groupId, optionKeys}`，不要提交组正文或任务指针。影响内容的变更会使旧组合失效，但已有联想组选项继续可用。

出图要求（site/textMode/personMode/personText/customText）实际变化后保存：无历史或原记录已联想/组织时，立即创建新记录，activeAdjustmentId=新ID、restoredFromAdjustmentId=null；该条尚未联想/组织时继续修改只更新该条。新要求清空 activeIdeationTaskId、activeCompositionTaskId 及旧刷新占位，保留已有组/全部选项/选择，自建维度也保留；按 activeGroups.producerTaskId 加载旧组，不因联想指针为空隐藏已有内容。保存成功后立即刷新历史，再使用响应的最新令牌/版本提交首次任务；相同内容重复保存不新增。仅模型或数量参数变化不新增。组织前保存选项可更新当前记录；组织后换选项/自建维度只保存独立副本（activeAdjustmentId=null、restoredFromAdjustmentId=来源ID），再次组织时分叉，避免覆盖旧记录原选择。

`POST /api/chetaidou/images/:id/draft/reset`，HTTP 200：

```json
{ "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690", "revision": 3 }
```

返回新草稿：original 站点、keep 文字/人物、空人物要求/补充要求、空选择/自建维度、空任务及组指针。模型和数量字段可能省略：模型使用目录首个可用项，数量默认 10–20 维、30–60 项。前端控件同时恢复这些默认值。reset 不创建历史，不取消已提交模型任务。

## 4 调整历史

| 方法和路径 | 返回 |
| --- | --- |
| GET `images/:id/adjustments?page=1&pageSize=20` | `{total,page,pageSize,items}`，按创建时间和 ID 倒序 |
| GET `images/:id/adjustments/:adjustmentId` | 单条记录及 `tasks` 数组，不切换当前草稿 |
| POST `images/:id/adjustments/:adjustmentId/restore` | HTTP 200，返回恢复后的当前草稿 |

表格路径均位于 `/api/chetaidou/` 下。记录形状：

```ts
interface Adjustment {
  id: string
  ownerId: number
  skuId: number
  imageId: number
  parentAdjustmentId: string | null
  schemaVersion: number
  revision: number
  createdAt: string
  updatedAt: string
  state: {
    settings: object
    selections: Array<{ groupId: string; optionKeys: string[] }>
    customDimensions: object[]
    activeIdeationTaskId: string | null
    activeCompositionTaskId: string | null
    activeGroupRefs: Array<{ groupId: string }>
    pendingRefreshTaskId: string | null
    facts: { id: number; version: number; contentHash: string }
    breakdown: { id: number; version: number; contentHash: string } | null
  }
  tasks?: object[] // 详情才有；复用现有任务投影
}
```

列表的站点取 `item.state.settings.site`。`parentAdjustmentId` 表示来源记录，不是组合问答的 `parentTaskId`。列表总数按调整记录计，不能用 Task 数量代替。

restore 请求使用**切换前当前草稿**的令牌和版本：

```json
{ "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690", "revision": 3 }
```

restore 只复制服务器保存的状态，不创建任务、模型调用或扣费。未提交过联想/组织且未继承其任务指针时，返回 activeAdjustmentId=来源ID、restoredFromAdjustmentId=null，继续保存要求、首次联想/组织复用原记录。已提交或继承过联想/组织则返回 activeAdjustmentId=null、restoredFromAdjustmentId=来源ID；实际修改要求保存即另存新记录，仅修改选项等保留工作副本，首次文本操作/答案/手动应用时再分叉，来源不变。失败、取消及组合指针清空不会解除已执行记录的隔离。两类 restore 都更换工作区令牌并递增草稿 revision。

新要求首次联想、当前轮首次组织、问答及出图归到最新记录；再次联想或再次组织开启新记录。重新组织新记录继承要求、已有联想组/选项、自建维度、选择和联想来源，不重新联想。新一轮 IDEATION 清空新草稿旧组引用/选择，旧记录保留；幂等重放和失败 retry 不新增。对未修改有效 READY 组合直接出图复用来源。普通 IDEATION/COMPOSE 提交时，历史 state.facts/state.breakdown 与该任务实际 snapshot 版本在同一事务同步；保存要求后的资料更新不会导致首次任务与历史版本引用不一致，各次任务冻结输入仍保留。

2026-10-15 用户确认：已有 A → 修改要求保存（立即创建 B，parentAdjustmentId=A）→ 未联想/组织前继续编辑（更新 B）→ 首次联想/首次组织/问答/多批出图（都归 B）→ 再次组织或换选项后组织（创建 C，完整继承上下文，B 原选择及提示词保留）→ C 再次联想（创建 D，不能因 C 没有自己的 IDEATION 就当作首次）。没有新增表、外部接口或字段；旧历史不合并、不回填，计费规则不变。尚未执行的保存记录可有空 tasks，前端不能过滤或等待模型提交后才展示。


恢复响应的 `activeGroups` 给出 `{groupId,producerTaskId,key,status}`。按其原顺序逐组调用：

```text
GET /api/chetaidou/tasks/:producerTaskId/groups/:groupId
```

不能把所有组都挂到当前 `activeIdeationTaskId` 查询：换一批后的组由独立 REFRESH_GROUP 任务产出，分支记录也会引用来源历史的组。成功选项 ID 继续按 `groupId.optionKey` 解析和渲染。

历史仍在执行时先展示真实 Task 状态。用户切走后，旧产物补齐所属历史，不自动改动新的工作区。若在产物完成前已经恢复该历史，完成后读取历史详情；未编辑的页面可再次 restore 加载最新状态，已经编辑的页面使用有效产物的 apply 操作或保留当前副本。失败占位同样从最新历史状态恢复，不能用旧 pending 指针永久禁用按钮。

## 5 提交联想、组合、换一批及问答

统一入口 `POST /api/chetaidou/tasks`，HTTP 202。所有类型都必须带当前 `workspaceId` 和 `draftRevision`：

```json
{
  "type": "COMPOSE",
  "imageId": 19,
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 4,
  "idempotencyKey": "b2c3d4e5-1111-4222-8333-444455556666"
}
```

IDEATION 使用相同公共字段并将 type 改为 IDEATION。REFRESH_GROUP 额外带当前成功组的 `groupId`；DIVERGE 额外带 `customDimensionId`。先等待保存成功，再提交使用其返回版本的任务。保存要求成功时即刷新历史列表，首次联想和组织提交后也读取最新草稿和历史。

修改站点、文字模式或补充要求后，保存并直接 COMPOSE/REFRESH_GROUP 即可；不需要传 `allowPartialIdeation` 解锁。已有 copy 选项可保留：跨语言时按当前目标语言转换含义；同语言保持所选原文；keep/hide/translate/show 以当前设置为准。硬事实、方案来源和选项存在性校验仍生效。修改后不能拿已失效的旧 READY 组合直接生图，先重新 COMPOSE。

冲突答案 `POST /api/chetaidou/compositions/:id/answers`，HTTP 202：在现有 `idempotencyKey,draftRevision,answers` 请求中增加 `workspaceId`。一次提交全部当前非阻断问题答案，响应的新组合任务沿原有 `parentTaskId` 链保存。

手动应用 `POST /api/chetaidou/tasks/:id/apply`：

```json
{ "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690", "draftRevision": 4 }
```

仅用于成功的 REFRESH_GROUP/DIVERGE；组合通过指针和详情读取，不调用 apply。发散执行期间若提交了新组合/答案、修改要求或改变维度名称/指引/选择模式，旧产物不自动覆盖当前组合和要求；保留结果供手动应用或放弃。apply 后重新 GET draft。取消、定向重试、放弃发散及下载接口维持原请求结构；重试复用原记录和冻结模型。

## 6 可选模型与生图

```text
GET /api/ai-models?modality=TEXT&category=CHETAIDOU_MULTIMODAL
GET /api/ai-models?modality=IMAGE&category=CHETAIDOU_IMAGE
```

使用返回 `items` 顺序；文本/图片都允许多个可用模型。选项 label 用 `displayName`，提交 value 用 `publicId`。文本目录的指定别名：Gemini 3.8 的 publicId `ZQ-Multimodal-Gemini-3.8-Flash` 展示为 ZQ-ZL-1，`ZQ-Think-Lite` 展示为 ZQ-ZL-2；其他条目沿目录展示。

图片条目新增 `recommended`。`ZQ-Image-1` 对应 NanoBanana2 开放通道，recommended=true；推荐标签不改变默认顺序，省略 imageModel 时仍使用首个启用且可用条目。空字符串不是省略字段，会返回参数错误。

```json
{
  "type": "GENERATE",
  "imageId": 19,
  "workspaceId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 5,
  "compositionTaskId": "d2c3d4e5-1111-4222-8333-444455556666",
  "count": 2,
  "imageModel": "ZQ-Image-1",
  "aspectRatio": "1:1",
  "resolutionTier": "1K",
  "quality": "standard",
  "idempotencyKey": "c2c3d4e5-1111-4222-8333-444455556666"
}
```

张数仍为 1/2/4/8。比例必须显式传，尺寸/质量按所选模型的 `facts` 和 `requestSchema` 渲染及校验。已核实的 ZQ-Image-1 schema v4 **只支持 standard 质量**，切换到它时不能遗留 hd；省略质量则按该模型默认值。后端不为不支持的质量偷偷换模型。

imageModel 是 GENERATE 参数，不是草稿 settings 字段；文本设置仍保存到 `settings.model`。生成提交后模型冻结，失败重试不会随目录默认值变化。任务详情的 `executionSettings.imageModel` 和预览墙条目的 `imageModel` 返回实际 publicId；恢复历史时可从详情中最近的 GENERATE 任务恢复图片模型控件，没有生成任务则使用当前目录默认项。目录中已停用的历史模型仍可展示其原 ID，不能作为新的可选项提交。

## 7 筛选与分页

```text
GET /api/chetaidou/skus/1/filter-options
GET /api/chetaidou/tasks?skuId=1&site=amazon_de&imageId=19&page=1&pageSize=20
GET /api/chetaidou/skus/1/results?site=amazon_de&imageId=19&page=1&pageSize=20
```

filter-options 返回 `{sites:string[],images:Array<{id,title,number}>}`，站点为全部支持的站点（与 config.sites 一致），母版为当前 SKU 下全部启用且本人可见的母版（预置 + 本人上传），不按历史使用记录过滤。全部筛选用省略参数，不能用 site=all 或 imageId=0。站点合法值：original、amazon_us、amazon_de、amazon_fr、amazon_es、amazon_it、amazon_jp；显示名称使用前端现有映射，语言区域映射可从 config.siteLocales 获取。

任务列表继续只显示根任务，多状态筛选用 `status=QUEUED,RUNNING`。预览墙包括未删除的占位、失败和成功图片，total 按图片项计；只有当前页资源签名。结果新增 `site,adjustmentId,imageModel`；任务详情、列表和批量 status 返回 `site,adjustmentId,workspaceId`。历史站点取任务提交快照，不随当前草稿修改。任务及结果列表的站点筛选优先使用 Task.site，旧任务该列为空时按 snapshot.settings.site 筛选，与响应站点回退口径一致。

任务按创建时间和 ID 倒序；预览墙按批次创建时间/批次 ID 倒序、批次内 index 顺序。两者的 total 都在筛选后计算。继续使用服务器 total，不能通过本地分页后的数量推算总数。母版或 SKU 不存在时按 404/业务异常处理。

## 8 用户自行部署与参考用例

已有车泰斗基础表时，用户自行执行 [本次增量 SQL](../../scripts/sql/2026-10-12-chetaidou-workflow-optimization.sql)。先选择目标 MySQL 数据库，在同一连接完整执行；支持重复执行，新增一张历史表、六个字段和四个索引，不回填业务数据。历史表的 10 个字段及 Draft/Task 的 6 个新增字段均含数据库 COMMENT；执行过旧版 SQL 时，重跑可补齐字段注释。文件末尾通过 COLUMN_COMMENT 检查实际字段注释。

需要 ChetaidouDraft/ChetaidouTask 基础表已存在，以及建表、改表、索引和临时存储过程权限。全新环境先安装原车泰斗结构，不能只用这份增量 SQL 安装整个平台。SQL 已对照 Prisma Schema 校验，未连接目标库执行。

执行 SQL 后生成 Client、构建并部署新后端：

```bash
npm run generate
npm run build
```

本轮由用户执行 SQL，不要求再运行 db:push 或 migrate。没有新增旧草稿/历史回填、价格调整或业务初始化操作。

登记 NanoBanana2 可选项，先只读预览，再执行：

```bash
node --env-file-if-exists=.env scripts/sync-chetaidou-image-model.mjs
node --env-file-if-exists=.env scripts/sync-chetaidou-image-model.mjs --apply --enable
```

脚本读取网关详情和请求 Schema，不生成图片。新模型排在旧目录后面；已有行只同步元数据，保留价格、启停和排序，已停用行不会因重复执行被自动启用。新行价格使用现有数据库默认值（priceMultiplier=1、fixedCredits=null），本轮未制定新定价；启用环境自行保留/设置其业务价格。目录未登记或未启用时，前端不会看到该项。

本地验证：20 套 Jest / 480 项通过，其中 HTTP 契约 4 项；初始化、模型及 SQL 一致性脚本 31 项通过；Prisma validate、Prisma Client generate、Nest build 通过。HTTP 测试使用真实 Nest 路由及 ValidationPipe，鉴权和服务被 Mock；业务集成使用 Mock Prisma/网关。这些结果不代表真实 MySQL 锁和真实生成已验收。

以下用例供前端接入时参考。按用户要求，不执行正式前端联调或真实付费生图，不作为本轮待完成任务：

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| F01 | 上传图拆解成功后直接联想 | 无确认弹窗；首次提交出现一条历史 |
| F02 | 对失败拆解读取详情、母版详情和状态轮询 | 显示统一失败文案；待核对继续等待 |
| F03 | 新建调整 | 全部控件及指针恢复默认，历史数不增加 |
| F04 | 恢复历史，改站点/要求直接组合或换一批 | 已执行记录创建新记录、保留来源；未执行记录继续编辑及首次任务复用来源 |
| F05 | A 执行中切 B，等待 A 完成 | B 不变；恢复 A 可读到最终组及来源任务 |
| F06 | 旧令牌保存/恢复，或同键换模型 | 409，不能覆盖当前草稿/创建重复任务 |
| F07 | 站点+母版筛选、翻页、切筛选清页码 | total、结果和历史分类一致，无跨用户数据 |
| F08 | 切 NanoBanana2，使用 standard 生成 | Task/Job/实际网关调用模型一致，失败重试不换模型 |
| F09 | 双请求同键同时提交、同步保存与任务完成竞争 | 隔离 MySQL 中只产生一条命令/历史；无重复调用/扣费 |

本轮代码、SQL、接入文档和本地验证已交付。SQL 的实际执行由用户负责，真实 MySQL 运行结果未验证。实现与测试台账见同目录 `README.workflow-optimization.tasks.md`。
