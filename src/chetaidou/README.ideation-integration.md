# 车泰斗联想：模型与数量选择——前端联调文档

更新日期：2026-10-06

本文对应本次后端实现。部署该版本后，新任务使用三维批次调用；旧任务继续按原快照执行。所有接口以 `/api` 开头，携带 `Authorization: Bearer <JWT>`；车泰斗业务接口继续要求已有工具权限。

## 1. 联调流程

```text
获取模型目录 + config
→ 获取母版草稿
→ 用户选择模型、维度数量、每维选项数量
→ PUT 保存完整草稿，更新本地 revision
→ POST 创建 IDEATION，使用新的 draftRevision
→ 轮询任务详情或批量状态
→ 根据成功 Group ID 按维加载 options
→ 部分失败时定向重试失败 Group
→ 重读草稿，再保存选择并提交 COMPOSE
```

前端不负责切批，不传维度定义或历史去重信息。后端先识别维度，按顺序最多三维一批调用模型，逐维独立入库。

正常联想调用次数为 `1 + ceil(实际维度数 / 3)`：识别一次，再按三维扩展；例如 10 维共 5 次。输出不合格可能增加修复调用，部分失败重试只调用所选失败维度。计费按实际调用账单结算，同一批不会因包含三维而重复扣三次。

## 2. 获取模型

```http
GET /api/ai-models?modality=TEXT&category=CHETAIDOU_MULTIMODAL
```

返回沿用已有结构，以下只列出前端需要的字段：

```json
{
  "items": [
    {
      "publicId": "ZQ-Think-Ultra",
      "displayName": "网关同步到数据库的实际名称"
    }
  ]
}
```

- 展示 `displayName`，提交 `publicId`，不要在前端维护模型名称对应表。
- 名称来源为网关 `display_name`，接口从数据库返回。
- 支持五个初始模型：`ZQ-Multimodal-Gemini-3.1-Pro`、`ZQ-Multimodal-Gemini-3.5-Flash-Lite`、`ZQ-Multimodal-Qwen-3.7-Plus`、`ZQ-Think-Flash`、`ZQ-Think-Ultra`。
- 以接口实际返回的可用目录为准，不在前端硬编码必须返回五行。
- 草稿有有效选择时恢复选择；没有选择时可使用目录第一项，建议明确写入草稿。
- 空目录时提示暂无可用模型，不提交空字符串或自动换成未知模型。

## 3. 两个数量范围

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `settings.dimensionCountRange` | 本轮识别的维度数量 | `{ "min": 6, "max": 6 }` 精确生成 6 维 |
| `settings.optionCountRange` | 每个维度的新选项数量 | `{ "min": 20, "max": 40 }` 每维 20–40 项 |
| `settings.model` | 本次文本任务模型 | 模型目录返回的 publicId |

范围含两端边界，`min=max` 表示精确数量。前端可以维护任意档位，不限于 10–20、20–40、40–60，也可允许自定义。

发送 JSON 数字，不发送 `"20-40"` 字符串。数量必须为非负安全整数且 min≤max；没有固定的维度 10–20 或选项 30–60 上下限。不应将零数量作为常规生成档位；满足本图必需维度或形成有效选项仍需要实际模型结果。

模型输出未满足范围会进入修复或失败，不会被后端静默缩小范围。大范围可能超出模型输出能力，前端应展示实际任务错误。

## 4. 保存草稿

先获取：

```http
GET /api/chetaidou/images/19/draft
```

保存完整草稿：

```http
PUT /api/chetaidou/images/19/draft
Content-Type: application/json
```

```json
{
  "revision": 6,
  "settings": {
    "site": "amazon_us",
    "textMode": "keep",
    "personMode": "keep",
    "personText": "",
    "customText": "",
    "model": "ZQ-Think-Ultra",
    "dimensionCountRange": { "min": 6, "max": 6 },
    "optionCountRange": { "min": 20, "max": 40 }
  },
  "selections": [],
  "customDimensions": []
}
```

此例是空选择的新草稿。已有选择和自建维度必须带回，不要因为更新模型或数量而将它们改成空数组。接口是完整草稿保存，不是字段补丁。

成功响应仍为草稿结构，包含新的 `revision`、`settings`、各任务指针、`activeGroupRefs` 和 `ideationStale`。立即用返回值更新本地版本。

只改模型或数量不会让已生成选项和组合失效；改站点、人物、文字、补充要求等内容设置仍可能使原联想过期。

收到 409 时保留未保存输入，重读草稿或使用错误返回的 currentDraft；不要自动用旧版本覆盖服务端。

## 5. 提交联想

```http
POST /api/chetaidou/tasks
```

```json
{
  "type": "IDEATION",
  "imageId": 19,
  "draftRevision": 7,
  "idempotencyKey": "430bf253-e97c-49fb-8bdc-f2e80931c690"
}
```

响应：

```json
{
  "taskId": "任务UUID",
  "status": "QUEUED"
}
```

模型和数量从已保存草稿读取，不放到此接口顶层。每次新操作生成新 UUID；同一次请求的网络重试复用原 UUID，避免重复创建付费任务。

必须先等待 PUT 成功，再提交 POST。若任务响应丢失，不应立刻换 UUID 再提交。

后端冻结提交时的模型、范围、提示词和维度上下文。此后修改草稿只影响新任务，失败重试也沿用原参数。

## 6. 状态与逐维结果

```http
GET /api/chetaidou/tasks/:taskId
```

也可使用已有批量轮询：

```http
GET /api/chetaidou/tasks/status?ids=<taskId1>,<taskId2>
```

任务详情包含新增 `executionSettings`，应以它展示任务实际使用的参数，而不是使用页面当前下拉框值：

```json
{
  "id": "任务UUID",
  "rootTaskId": "根任务UUID",
  "type": "IDEATION",
  "status": "PARTIAL",
  "executionSettings": {
    "model": "ZQ-Think-Ultra",
    "dimensionCountRange": { "min": 6, "max": 6 },
    "optionCountRange": { "min": 20, "max": 40 }
  },
  "progress": { "total": 6, "processed": 6, "succeeded": 5, "failed": 1 },
  "groups": [
    {
      "groupId": "维度UUID",
      "key": "background",
      "label": "背景场景",
      "status": "SUCCEEDED",
      "optionCount": 25,
      "errorCode": null,
      "errorMessage": null
    }
  ]
}
```

示例仅展示一个 Group；实际 groups 包含完整清单。progress 按维度计数，不是按模型批次计数。识别完成前可能还没有 Group 清单。

对成功维度按需加载完整选项：

```http
GET /api/chetaidou/tasks/:taskId/groups/:groupId
```

响应包含 `groupId`、`parentGroupId`、`producerTaskId`、`definition`、`options`、`status`、`order`。options 的 `selectionId` 由服务端生成，保存选择仍使用原有 `groupId + optionKeys` 契约。

任务尚在运行时，已成功 Group 可加载展示。保存用于组合的选择前，应重读草稿并采用服务端当前有效 Group 引用；联想完成或部分失败收尾后会写回 `activeGroupRefs`。

## 7. 单维或多维失败重试

只有 FAILED 或 PARTIAL 任务可以重试，只提交 FAILED Group ID。

```http
POST /api/chetaidou/tasks/:rootTaskId/retry
```

```json
{
  "idempotencyKey": "新操作UUID",
  "draftRevision": 8,
  "groupIds": ["失败维度UUID"]
}
```

响应：

```json
{ "taskId": "重试任务UUID" }
```

- 一维失败可单独重试，其他成功维度不覆盖。
- 多维失败按最多三维重新分批；已有识别清单时不重新识别维度。
- 前端继续保留根任务展示；根任务状态、进度和同一批 Group ID 会更新。
- 返回的子任务 ID 可用于轮询，也可继续轮询根任务。
- 重试不传新的模型或范围；想换参数应保存新设置并重新联想。
- 成功、运行中、UNKNOWN 的 Group 不可当作失败目标重试。
- `OUTPUT_APPLY_FAILED` 表示已收到有效回执但应用落库失败。重试优先重新应用原结果，不重新调用模型。
- 手动重新生成或输出失败重试可能产生新费用。

## 8. 状态和按钮

| 任务状态 | 前端处理 |
| --- | --- |
| QUEUED | 排队，继续轮询；沿用已有取消入口 |
| RUNNING | 展示逐维进度，已成功 Group 可加载 |
| SUCCEEDED | 全部完成，重读草稿，允许选择与组合 |
| PARTIAL | 保留成功维度，提供失败维度重试 |
| FAILED | 展示实际错误；确认失败目标后重试 |
| WAITING_RECONCILIATION | 待核对，不自动重试，不提示重新提交同一次调用 |
| CANCELLED | 已取消 |

Group 的 UNKNOWN 表示调用状态不明，不等同 FAILED。网络失败时后端不会盲目重发模型请求。

## 9. 刷新、发散和组合

上述设置先保存到草稿，再沿用原创建任务接口：

| 操作 | type | 额外字段 |
| --- | --- | --- |
| 刷新维度 | REFRESH_GROUP | `groupId` |
| 自建维度发散 | DIVERGE | `customDimensionId` |
| 组合 | COMPOSE | 可选 `allowPartialIdeation` |

新刷新和发散使用当前模型及每维选项范围，已有或保留项不计新增数量；`dimensionCountRange` 不会使单维操作变成多维识别。

新版本全部成功的少于 10 维联想也可以组合。PARTIAL 结果默认需要重试失败维度；用户明确选择使用部分结果时，提交 COMPOSE 加 `allowPartialIdeation: true`，仍需满足当前画面的必需维度。旧任务保留原版本门槛。

## 10. config 和旧客户端兼容

```http
GET /api/chetaidou/config
```

`limits` 新增 `ideationBatchSize: 3` 和 `executionVersion: "ideation-batch-v1"`。不再返回固定 `minDimensions`、`maxDimensions`、`minOptionsPerGroup`、`maxOptionsPerGroup`、`maxOptionsPerDimension`。

前端应移除对这些旧值的依赖及固定“至少10维”“每维最多60项”“自建维度累计300项”的本地拦截。其他文字长度、自建维度数量、生图数量规则沿用 config。

旧客户端新提交时，未传维度范围使用 10–20，未传选项范围使用 30–60；未传模型按目录排序取默认值。这些只是缺省兼容值，不是新任务上下限。旧任务不会被改写成新批次模式。

若前端有接入适配层（如 `studio-backend.mjs` 的 settingsToBackend），必须将三个新增设置字段加入序列化白名单；本次交付没有修改前端仓库。

## 11. 常见错误

| 场景 | 处理 |
| --- | --- |
| 400 范围格式无效 | 检查数字、非负安全整数、min≤max，不做固定档位检查 |
| MODEL_NOT_READY | 重新获取模型目录，提示所选模型不可用 |
| SETTINGS_CHANGED / 409 | 保留本地输入，刷新草稿版本，不自动覆盖 |
| BREAKDOWN_UNCONFIRMED | 沿用拆解确认流程 |
| MODEL_OUTPUT_INVALID | 展示维度错误，允许确认失败目标的修复或重试 |
| WAITING_RECONCILIATION | 等待核对，不自动创建新请求 |

沿用现有全局错误响应和业务 code；不要假定所有错误都包含 currentDraft。

## 12. 前端验收清单

- 五模型名称来自接口，可正确保存和恢复 publicId。
- 保存精确 6 维和每维20–40项时，任务回显参数正确。
- 少于10、多于20维，以及非预置选项范围可以提交。
- PUT 成功后用新 revision 提交任务，不丢已有选择。
- 三维批次调用在页面上仍展示为独立维度。
- 部分失败保留成功结果，单维重试不覆盖其他选项。
- 切换当前模型或数量不改变在途任务参数。
- 待核对状态不出现自动重试循环。
- 少于10维全部成功可组合，部分成功需要明确允许。
- 不依赖已取消的固定数量 config 字段。

## 13. 部署和目录同步

后端无新增表或列，不需要执行结构同步。完成全部后端实例升级后再切换前端新增参数，避免旧实例过滤参数或使用旧执行器。

在目标环境同步五个模型（仅读取网关元数据，不生成内容）：

```bash
node --env-file-if-exists=.env scripts/sync-chetaidou-text-models.mjs --enable --multiplier=1 --dry-run
node --env-file-if-exists=.env scripts/sync-chetaidou-text-models.mjs --enable --multiplier=1
```

`--multiplier` 只设置新增记录价格，示例 1 为项目 TEXT 默认倍率；已有价格及排序不覆盖。`--enable` 明确启用本次清单，缺省不改变旧启用设置。displayName 从网关查询同步，不手工填写。同步只作用于模型目录，不承担母版或历史数据维护。

本次已在当前配置连接的数据库完成五模型登记与启用；其他部署环境需分别同步。本次没有执行真实内容生成联调，避免额外付费请求；生成流程、失败隔离和恢复已通过自动化测试验证。
