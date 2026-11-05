# 成功生成记录快照

本次只新增 `GenerationRecord` 表，不修改 UsageLog/CreditTransaction 的结构，不产生 AI 调用或扣费。默认列表、count、summary、model-options 从新表读取；旧实现仅作为显式回滚路径保留。数据库建表和真实回填（包括 dry-run）由部署人员执行，开发过程中未执行。

## 最终业务口径

与 `lsx/optimize-user-generation-records` 分支口径一致：**只记录成功业务操作；成功后快照不再改变。再次成功优化并产生新消费是新事件、新记录。** 原方案中的“ASIN 两阶段累计覆盖”“雷达只保留最新刷新”“删除时同步汇总”均已取消。

- 不记录进行中、失败、取消、孤立 BILLED 扣费。真实费用未知为 `null`，明确免费为 `0`，已知积分保留 Decimal(18,4)，不从人民币反推费用。
- 同一业务成功事件的回调、重放或回填通过 `(sourceType, sourceId, operation)` 去重，已经存在时不更新任何快照字段。业务编辑、删除、部分产物移除、退款、目录改名都不更新已保存快照，也没有相应同步钩子。
- 本文的“重试”指同一成功事件重放；RPA 重试失败输出后**新产生成功结果和新扣费**，按新的成功输出批次记录。
- 正文继续留在业务表；不承诺源正文被删除后可以恢复。已有详情权限和删除判断保持原样；列表保留成功时的元数据和预览快照。详情仍仅支持文本，不加 14 天限制。
- 用户名称、手机、组织、角色实时读取。模型 publicId 和真实目录展示名在写入时拍快照；不把 `fixed-module` 或任意 code 当展示名。目录缺失保留 null，RPA 仅使用其已注册的静态模型目录作为可信补充。

覆盖原有 14 功能：IMAGE、VIDEO、INSPIRATION_RADAR、ASIN_EVIDENCE、ASIN_AUDIT、COMPETITOR_ANALYSIS、LISTING_GENERATION、LISTING_SCORING、CATEGORY_ANALYSIS、PRODUCT_SELECTION（仅 PRODUCT 入口）、SMART_PRICING、PROMOTION_PLAN、VIDEO_ANALYSIS、CHETAIDOU_TEXT。vidflowos 与 platform 隔离；CROP 不计入；车泰斗 GENERATE 仅属于 IMAGE。

## 事件身份和正文

| 来源 | 事件身份/说明 |
|---|---|
| 普通图片、视频、分镜、美妆 | 原任务 ID；业务终态成功且结果已保存时写入 |
| 拆图 | groupId（历史空组退化 task:id）；按方向席位合并，不按图片制造行 |
| ImageGenJob | jobId；归档时若已有成功 IMAGEGEN 快照则保持，归档任务不再复制一份费用。历史仅归档任务可恢复时使用 IMAGE 身份 |
| ASIN 证据 | `TEXT:ASIN_EVIDENCE:{reportId}`，证据和本次费用一行 |
| ASIN 打分 | `TEXT:ASIN_AUDIT:{reportId}:score`，固定评分快照 |
| ASIN 每次优化 | `TEXT:ASIN_AUDIT:{reportId}:revision:{revisionId}:optimize`，正文精确指向该 revision；相同正文再次独立收费保留同一 revision，额外事件 key 为 `...:revision:{revisionId}:event:{usageLogId}:optimize`，费用逐笔分开；费用优先明确 revisionId，再匹配结果 hash，旧数据仅全用户同阶段窗口双向唯一才用时间邻近，绝不均摊报告累计费用 |
| Listing 每次成功任务 | `TEXT:LISTING_GENERATION:{historyId}:task:{taskId}`，正文读取该任务已保存的结果和自动评分；采纳优化独立扣费、独立记录。A/B 同一计费标识证明已经扣过的任务可明确为 0，不能重复分摊原费用 |
| 旧 Listing 无任务 | `TEXT:{TYPE}:{historyId}:revision:{historyRevisionId}`，指向固定 HistoryRevision，不随 History.data 编辑改变 |
| RPA 成功输出批次 | `RPA_IMAGE/VIDEO:{taskId}:event:{usageLogId}`，按明确 successfulOutputIds 取本批成功结果和该笔 UsageLog；全失败不记录 |
| 雷达每次成功刷新 | `INSPIRATION_RADAR:{subscriptionId}:refresh:{lastRefreshedAt毫秒}`，每次独立成功刷新一行。原始 API id 仍为订阅数字 ID |
| 竞品运行/归档 | 已有成功 TEXT_RUN 快照时保留；后续归档不再复制费用 |
| 车泰斗文本 | BREAKDOWN/IDEATION/REFRESH_GROUP/DIVERGE/COMPOSE；根任务成功时合并其重试调用费用，重试任务不重复列出；PARTIAL 文本不作为全部成功。图片 PARTIAL 按已有可交付成功图片口径归 IMAGE |

旧文本 key 详情仍可用。新增 key 是不透明标识，前端应完整传给原详情接口，不截取 UUID 或自己拼接阶段；新 key 列表里的 id/recordId 继续提供原业务父 ID。

## 写入和费用完整性

成功钩子显式位于原业务成功保存/结算方法末尾，必须在原业务事务提交之后调用：`recordGenerationSuccess` 仅接受根 PrismaClient，使用独立短事务，任何投影/写入/超时异常只记录具体 source/id，不向业务抛出，不回滚已完成的业务或扣费。调用方等待本次写入尝试结束，仍会有额外查询耗时。只读取一个明确实体或拆图组，费用匹配复用原有严格业务标识；媒体 SQL 额外带 taskId/jobId/groupId，绝不扫描用户全历史后 JS 猜匹配。没有全局 Prisma 中间件、事件总线、队列表、请求时补跑全量回填。

竞品的服务端自动归档先只保存正文，待真实结算完成才首次建快照；无运行号或非 UUID 运行号也用明确 reportId + 真实扣费返回值捕获，禁止先冻结 null 再丢失后续实扣。车泰斗复用现有 ChetaidouCall 的 SETTLED/chargedCredits 或 FREE 作为真实结算证据，尚未完成的调用不会被当作零元或部分合计。

网关、固定模块、RPA、ASIN 等在原业务保存/真实扣费事务提交后创建快照，不更改扣费路由、金额、幂等或退款行为。多产物生图原本先保存结果再独立扣费，不能在第一笔扣费到达时冻结部分费用。因此仅复用原 JSON 存内部证据：`ImageGenItem.gatewayImage.generationRecordCredits`、`GeneratedImage.deliveryMeta.generationRecordCredits`。证据写入失败也只记日志，不把成功图片改成失败。

- 缺字段：尚未确认或历史无证据，不能据此冻结部分费用。
- 明确 null：结算尝试已结束但费用未知/扣费失败；成功结果的积分快照可保留 null。
- 数字字符串（含 `"0"`）：真实扣费返回值或已确认免费。重复扣费幂等返回的真实 credits 仍是有效证据。
- 原有精确 gatewayTaskId 台账也可证明该成功图已完成结算。全部成功图具有证据后才首次入表；后续 aggregate 重放不会覆盖记录。
- 这些字段为内部结算证据，公开图片元数据响应会剔除。任务级 token 批量扣费的证据仅表示该批已结算，最终总额仍读一次真实 UsageLog，不重复累加每个图片证据。

不在资金事务内从 UsageLog 创建反向锁业务来源，避免钱包锁与来源锁顺序反转。生成/扣费没有因本次需求新增自动重试。写入失败或提交后进程退出可能缺少生成记录，应按日志 source/id 或现有回填脚本补建；没有自动保证最终写入。不得重新调用 AI 或重复扣费来“修复生成记录”。手工回填的 `--apply` 仍显式报错并中止，不吞掉脚本错误。

## 部署顺序（用户执行）

先同步结构、启用成功写入并回填，再切新读。保留原始业务表和台账，不跑 migrate。

回填命令在已安装开发依赖（ts-node/TypeScript）的源码目录运行，并核对目标 `.env` / `DATABASE_URL`。只有 dist 或只安装生产依赖的运行镜像不一定包含脚本和 ts-node，不能直接假定任意生产容器都可执行。

```bash
# 1. 在目标环境核对 DATABASE_URL 后执行；本项目唯一的 schema 同步方式
npm run db:push
npx prisma generate

# 2. 部署本版，暂设 GENERATION_RECORD_READ_MODE=legacy，重启应用
#    此阶段仍旧读，成功业务已同时写入新表。

# 3. 只读预览，默认也是 dry-run；不写库、不执行锁 SQL
npm run backfill:generation-records -- --dry-run
npm run backfill:generation-records -- --dry-run --function ASIN_AUDIT --batch-size 100

# 4. 确认预览后正式回填，明确 --apply 才写新表
npm run backfill:generation-records -- --apply

# 5. 核对各功能/事件数、未知费用和成功快照费用后
#    删除 GENERATION_RECORD_READ_MODE 或设为 unified，重启切新读。
```

CLI 支持 `--function`（14 个功能之一）、`--from`/`--to`（建议完整 ISO 时间）、`--batch-size 1..1000`、`--cursor source:id`。时间默认近 14×24 小时；脚本不调用列表 API，不受列表 14 天上限截断。指定更早时间可分批回填。

```bash
npm run backfill:generation-records -- --dry-run --from 2026-10-01T00:00:00+08:00 --to 2026-11-01T00:00:00+08:00
npm run backfill:generation-records -- --apply --function ASIN_AUDIT --cursor asinAuditRecord:报告UUID
```

每批输出 `cursor`，断点从该源最后 ID 之后继续，并继续后续来源。重跑安全：upsert 的 update 为空，已经冻结的记录不会被历史扫描或后来台账修改覆盖。ASIN 查询包含老根报告的近期 revision；Listing 包含老 History 的近期成功任务；RPA/车泰斗也涵盖近期成功完成的旧任务。

输出 `scanned` 是源实体扫描数，`successful/written` 是成功候选/幂等写入尝试数（同组/根可能重复，不是实际新增行数）；`distinctResults` 按事件 key 去重。apply 的 `knownCredits` 与未知费用数取真实保存或已有的冻结快照，不能用退款后的新投影金额冒充历史快照。dry-run 展示来源候选，不触发任何写语句。

## 历史边界和回滚

- 历史缺正文、实际目录模型或准确台账关联时不伪造。历史孤立扣费不入表，也不声称恢复所有历史生成操作。
- 雷达原表只保留最新刷新结果；本次上线前的更早刷新无法从台账单独证明保存成功，回填仅恢复可证明的最新成功刷新。新刷新会逐次留快照。
- 旧 RPA 缺成功输出批次标识时不制造批次，最多保留可证明的任务级成功结果，金额无法唯一确认则 null。
- 退款/删除/修复历史台账不改变已冻结记录。若确需更正既有快照属于单独审计操作，不由脚本重跑悄悄覆盖。
- 回滚查询：设置 `GENERATION_RECORD_READ_MODE=legacy` 并重启，继续成功写入；不要删表、不要改历史钱包余额。旧读会恢复旧的状态/累计口径，与新成功事件快照不是逐行完全相等。
- API 路径、JWT + company.admin、DTO、原样 JSON 包装保持；列表及模型选项仍硬限近 14 天，同一请求同一 now/where，数据库分页及全筛选集 count/sum。正文源删除后的可用性仍由原业务详情决定。

## 本仓库验证

2026-11-05：Prisma schema 校验与 Client 生成、Nest 构建通过；新增生成记录模块及查询/回填核心 ESLint 通过。全量回归 313 套通过、2 套跳过，5355 项通过、4 项跳过，2 个快照通过。HTTP/SSE 测试在允许本机临时端口监听的环境下执行。

未执行目标数据库的 db:push、任何真实回填（包括 dry-run）、AI 调用或真实扣费。功能在 sellerOs-api 的 codex/registration 分支实现，部署时仍需按上述顺序建表、回填和切换查询。
