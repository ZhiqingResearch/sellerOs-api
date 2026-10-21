# 车泰斗流程优化开发与测试台账

日期：2026-10-12。开发分支：`lsx/feat-chetaidou-workflow`，基于 `e8c06a3` 实现，合并目标为 `lsx/develop`。代码、SQL 和文档交付完成；SQL 由用户自行执行，正式前端联调和真实生图按用户要求不执行。前端使用 [联调文档](./README.workflow-optimization.integration.md)。

实施状态表示代码和文档是否交付；测试状态记录本地验证及实际执行边界，不能将 Mock 通过记为真实数据库或模型生成通过。2026-10-12 用户取消正式前端联调和真实生图验收；目标 SQL 执行移交用户，不再作为本轮代理待完成任务。

## 1 分任务记录

| 任务 | 实施状态 | 实际交付 | 已通过的验证 | 部署责任与验证边界 |
| --- | --- | --- | --- | --- |
| T00 基线核对 | 已完成 | 分支、现有接口、初始 459 项 Jest / 29 项脚本基线 | 基线及 Prisma Client 重新生成后的构建 | 无 |
| T01 数据结构 | 已完成 | ChetaidouAdjustment；Draft 工作区/记录指针；Task 记录/工作区/站点字段及索引；集中 SQL 及本次增量 SQL | Prisma generate、validate；SQL 与 Schema 的只读 DDL 对照测试 | SQL 用户执行；真实 MySQL 未验证 |
| T02 上传与失败文案 | 已完成 | AI_UNREVIEWED 成功稿直接联想；FAILED 拆解统一文案；技术原错保留 | 未确认直接联想；三种失败详情/状态投影；现有待核对/取消回归 | 正式前端联调按用户要求不执行 |
| T03 草稿与历史接口 | 已完成 | reset、历史分页/详情/restore；CAS 令牌；完整表单及有效组来源恢复 | 默认值、旧版本拒绝、跨用户拒绝、来源不变、activeGroups；HTTP 请求校验 | 真实并发 reset/restore 与跨标签页操作 |
| T04 历史创建与分叉 | 已完成 | 保存要求同事务建记录；未联想/组织前编辑复用；首次联想/组织复用，重新执行分叉并继承上下文 | 保存即建、未执行时更新、首次任务复用、继承联想识别、选项副本隔离、幂等与写失败回滚 | MySQL 同键并发唯一约束与事务回滚 |
| T05 异步隔离 | 已完成 | 结果先补所属历史，仅令牌/指针匹配时同步当前 Draft；取消/重试释放正确占位；根任务重复完成不覆盖新组版本 | 切走后联想/发散完成、旧刷新取消、已刷新组保护、发散目标语义修改保护；既有 concurrency/reconciliation 回归 | 真实数据库锁竞争、重启后对账回执 |
| T06 历史修改后继续 | 已完成 | 移除旧联想上下文阻断；新设置冻结进 COMPOSE/REFRESH；来源/选项有效性校验；跨语言所选文案语义复用 | 历史修改后直接组合/换一批；DE 快照；不同语言可转换、同语言原文保护、错误语言拒绝 | 真实生成验证不列入本轮范围 |
| T07 筛选和分页 | 已完成 | site/imageId；本人 SKU 筛选项；先筛选再分页；候选轻量查询，详情/签名仅当前页 | 站点与母版组合筛选、total/翻页、空结果不签名、当前页签名数；原软删除/下载隔离 | 真实 SQL 查询和大量历史性能 |
| T08 生图可选模型 | 已完成 | imageModel 请求参数；多模型默认排序；冻结 Task/Job；响应返回实际模型；元数据登记脚本 | 显式模型冻结、同键换模型拒绝、目录多模型、尺寸/质量与失败重试原回归 | 目录由部署环境配置；真实生图按用户要求不执行 |
| T09 别名与初始化 | 已完成 | 两个文本别名只影响车泰斗展示；ZQ-Image-1 推荐；初始化支持多模型；旧切换脚本保留其他模型，回滚仅目标行 | 分类隔离、推荐 publicId；脚本 dry-run、重同步保留价格/启停/排序；31 项脚本回归 | 目标环境目录配置 |
| T10 联调和交付 | 已完成 | 增量 SQL、DTO/Swagger、前端联调文档、台账、完整定向回归及构建 | 20 套 Jest / 480 项；其中 Nest HTTP 契约 4 项；31 项脚本；构建通过 | SQL 用户执行；正式前端联调/生图不执行 |

## 2 实现位置和技术约定

| 内容 | 文件 |
| --- | --- |
| 表、字段、索引 | `prisma/schema.prisma` |
| 历史状态、锁、CAS、写回 | `src/chetaidou/chetaidou-adjustment.ts` |
| 接口、提交事务、列表投影 | `chetaidou.service.ts`、`chetaidou.controller.ts`、`dto/chetaidou.dto.ts` |
| 异步完成及发散应用 | `executor/chetaidou-task-runner.service.ts`、`chetaidou-draft.ts` |
| 失败、上下文、文案规则 | `chetaidou-errors.ts`、`chetaidou-context.service.ts`、`chetaidou.schemas.ts`、`chetaidou.prompts.ts` |
| 生图模型/参数 | `chetaidou-image-options.service.ts`、`src/ai-gateway/ai-gateway-model.service.ts` |
| 目录登记及部署资料 | `scripts/sync-chetaidou-image-model.mjs`、`scripts/chetaidou/image-models.mjs`、初始化/切换脚本和集中 SQL |

历史复用现有 Draft、Task、Group、Call 和 ImageGenJob，不复制产物或新增计费服务。共享逻辑是事务辅助函数，复用调用方 TransactionClient，未另设只有单用途的注入服务。

修改要求保存时创建记录，未联想/组织前反复编辑复用；新要求首次联想/组织、问答、刷新、发散及出图关联最新记录，再次联想或组织分叉。已组织记录换选项先保存独立副本，重新组织才另存，保留旧记录原选择；未联想/组织的记录恢复后继续更新原记录，已执行历史的恢复副本实际修改要求时保存即分叉，其他文本操作仍按来源隔离。读取、下载和现有 READY 组合生图复用来源。异步运行字段可补齐来源记录，已执行历史恢复后或修改要求新建记录后的表单不会反写来源。Task 的工作区标识用于隔离写回，历史 parentAdjustmentId 与组合 parentTaskId 各自保留。

站点状态筛选保留根 Task 与 Job 的原聚合口径，轻量候选 ID/状态仍在内存合并；只读取本页重型快照及关联资源。没有新增缓存、搜索服务、分页上限、旧数据迁移或新的价格规则。

## 3 本轮实际验证记录

| 命令/检查 | 结果 | 验证边界 |
| --- | --- | --- |
| `npm run test -- --runInBand --testPathPatterns='chetaidou\|ai-gateway-model'` | 20 套 / 480 项通过，0 失败 | 业务集成为 Mock Prisma/网关；HTTP 为真实 Nest 路由和 ValidationPipe，鉴权/服务 Mock |
| `npm run chetaidou:init:test` | 31 项通过，0 失败 | 模型元数据和数据库均 Mock；集中 SQL 只做 Schema 对照，不执行数据库 DDL |
| `npm run generate` | 通过 | 本地生成 Client，不同步目标库 |
| `npx prisma validate` | 通过 | Schema 静态校验 |
| `npm run build` | 通过 | Nest 生产构建 |
| `git diff --check` | 通过 | 差异空白检查 |
| 网关 models.get / models.requestSchema 只读核查 | ZQ-Image-1 = NanoBanana2 开放通道；支持 edit；schema v4，quality 仅 standard | 没有调用 images.generations，没有生成或扣费 |

最终日志在本次工作环境 `/tmp/chetaidou-final-test.log`、`/tmp/chetaidou-final-jest.json`、`/tmp/chetaidou-final-scripts.log`、`/tmp/chetaidou-final-build.log`、`/tmp/chetaidou-prisma-validate.log`。这些临时文件不随 Git 发布；本台账保留最终结果。

测试过程中遇到并修复：新历史测试的作用域错误；旧单模型与已读门槛断言更新；新增 Schema 与原 SQL 的不一致；重复完成覆盖刷新版本；旧轮选择引用清理；发散目标变更时拒绝自动应用。HTTP 首次运行因沙箱禁止监听端口失败，允许本地测试端口后 4 项通过。最终结果包含上述修复，不把中间失败当成未执行。

## 4 用户确认的交付范围

2026-10-12 用户确认：“执行sql给我自己执行，不用正式前端联调给文档即可，生图也不用”。本轮按此交付完成，不等待正式前端联调或付费生成。第 1 节各任务的真实环境验证项仅描述未覆盖边界，不是本轮待办。

- [流程优化增量 SQL](../../scripts/sql/2026-10-12-chetaidou-workflow-optimization.sql)：已有车泰斗基础表的库可重复执行，仅新增历史表、六个字段和四个索引。
- [前端接入文档](./README.workflow-optimization.integration.md)：请求、响应、工作区令牌、历史恢复、筛选和模型参数均已交付。
- SQL 对照当前 Prisma Schema 的表、字段、索引定义进行只读自动校验，含 16 个数据库字段 COMMENT 及旧版已建字段补注释检查；补充校验日志为 `/tmp/chetaidou-sql-delivery-tests.log`，31 项脚本测试通过。未连接目标数据库，未执行任何 DDL、业务初始化、模型登记或生图。

| 操作 | 当前状态 | 实际结果 |
| --- | --- | --- |
| 增量 SQL 交付与静态校验 | 已完成 | 结构定义和幂等保护检查通过 |
| 目标库 SQL 执行 | 用户自行执行 | 代理未执行，真实 MySQL 运行结果未验证 |
| 正式前端联调 | 按用户要求不执行 | 文档已交付 |
| 真实模型生图与扣费验证 | 按用户要求不执行 | 未生成、未扣费 |

用户执行 SQL 后生成 Prisma Client、构建并部署即可；本轮不要求再执行 db:push/migrate。图片模型登记脚本仅同步目录元数据，不生成图片，其用法保留在接入文档中。

## 5 2026-10-13 历史按一轮调整归并

用户最终确认：调整要求、重新联想、首次组织提示词和出图只新增一条历史；已有组织任务后单独重新组织也要新增一条。要求保存不再建历史，而是更换工作区令牌、保留来源 ID、解除旧刷新占位；首次文本提交创建本轮记录。本轮首次组织、冲突问答和多批生图复用记录，完整重新联想或单独重新组织开启下一轮；已有记录不合并。按记录关联的 COMPOSE 任务识别重新组织，不依赖可失效的当前组合指针；答案入口用内部 ANSWERS 操作延续本轮，不改变对外 Task.type=COMPOSE。复用现有字段，无新增 Schema、SQL 或接口，计费内核不变。

最终规则验证：18 套 / 515 项车泰斗及回执回归全部通过（含 174 项联调回归和 4 项 HTTP 契约），Nest 构建与三个修改 TS 文件的 Prettier 检查通过。覆盖整轮只新增一条、反复保存、单独重新组织分叉、选择变更清空组合指针后重新组织仍分叉、冲突问答、多批出图、幂等重放、恢复完整状态，以及修改要求后晚到联想/刷新和旧组合完成的隔离。HTTP 测试允许本机临时端口；业务存储及模型调用仍为 Mock。日志：`/tmp/chetaidou-recompose-jest.log`、`/tmp/chetaidou-recompose-build.log`。

两个生产 TS 文件 ESLint 通过；测试文件完整 ESLint 检查仍有两处既有 unbound-method 错误（原有生图模型 mock 断言，未改动），未为本需求修改无关代码。未执行真实数据库、生图或正式前端联调，前端契约同步到联调文档。

## 6 2026-10-15 历史记录回归修复

发散提交时冻结来源组合指针，自动应用前锁定来源记录并核对；若后来已提交组织或冲突答案，保留发散产物供手动应用，不清空当前草稿和历史的组合指针。已有组合后主动发散、指针未变化时仍可自动应用。旧组合无 Adjustment 归属时，首次提交答案补建历史，重放及后续出图复用记录。

新增 5 项回归，覆盖排队/READY/冲突问答下的晚到发散、手动应用、READY 组合继续出图、已有组合后发散正常自动应用，以及旧组合答案补建历史/幂等/出图归属。18 套 520 项车泰斗及回执回归通过，另 6 项脚本/SQL 测试通过；Nest 构建、三个生产 TS 文件 ESLint 和四个修改 TS 文件格式检查通过。测试文件仍只有原有两处 unbound-method 错误。HTTP 契约测试需允许本机临时端口，业务存储和模型仍为 Mock；未执行真实数据库、生图和前端联调。日志：`/tmp/chetaidou-history-fix-regression.log`、`/tmp/chetaidou-history-fix-http.log`、`/tmp/chetaidou-history-fix-build.log`。


## 7 2026-10-15 保存要求即建历史、首次任务复用

本节替代第 5/6 节中旧的历史创建节点说明，前述验证记录保留供追溯。要求实际变化时保存即创建记录；该条尚未联想/组织前继续修改只更新。新要求清空联想/组合指针但保留组引用及全部选项，首次联想与首次组织复用；重新组织继承联想来源，随后再次联想仍分叉。组织后换选项先保存独立副本，提交组织时新建，旧记录选择与提示词保留。发散自动应用同时校验冻结要求，避免未执行记录编辑后旧产物写回。

复用现有历史、草稿、任务、组版本及事务/CAS，无新表、接口或对外字段。新增 8 项回归并调整旧规则断言，覆盖首次保存、未执行反复编辑、首次任务复用、继承联想后分叉、排队/失败/取消冻结、写失败回滚、未联想直接组织后改要求、旧发散隔离及手动应用；保留问答/多批出图/幂等/恢复/晚到结果等回归。

验证结果见本次运行日志 `/tmp/chetaidou-save-history-tests.log`、`/tmp/chetaidou-save-history-build.log`、`/tmp/chetaidou-save-history-eslint.log`。中文前端联调文档为 `docs/车泰斗历史调整修复-前端联调文档.md`（本地，不纳入版本管理）；本次按用户要求不提交、不推送，不执行真实数据库、生图或前端联调。

本次最终验证：18 套 / 528 项车泰斗及回执回归通过（含 187 项联调回归和 4 项 HTTP 契约）；Nest 构建、三个生产 TS 文件 ESLint 与四个修改 TS 的格式检查通过。完整测试文件 ESLint 仍仅有两处原有 unbound-method 错误，无本次新增问题。

## 8 2026-10-15 未执行历史恢复及资料引用修复

restore 在历史锁与草稿 CAS 事务内核对记录的继承指针及已关联 IDEATION/COMPOSE 任务。未联想/组织的记录恢复为活动历史，后续编辑、首次联想/组织不再多建一条；失败、取消或指针已清空的已执行记录仍恢复为独立副本，保留来源。普通联想/组织提交时，将实际任务快照的事实卡及拆解版本引用一起写入当前记录，避免要求保存后资料更新导致历史引用仍停在旧版本；每次任务的冻结输入不变。

新增 8 项回归：未执行历史恢复后首次联想/组织复用（2）、恢复后修改要求更新（1）、联想/组织失败且指针清空仍隔离（2）、首次联想/组织同步实际资料版本（2）、历史更新失败时草稿/任务/资料引用整体回滚（1）。先运行新增核心用例复现 5 项失败，再修复实现。

验证：18 套 / 536 项车泰斗及回执回归通过（含 195 项联调回归、4 项 HTTP 契约），另 6 项脚本/SQL 测试通过；Nest 构建、三个生产 TS 文件 ESLint、四个修改 TS 文件格式及差异检查通过。日志为 `/tmp/chetaidou-history-resume-regression.log`、`/tmp/chetaidou-history-resume-build.log`、`/tmp/chetaidou-history-resume-scripts.log`、`/tmp/chetaidou-history-resume-eslint.log`。中文联调文档同步 restore 两类响应、资料版本规则及 H20–H22 验收用例。未执行真实数据库并发、模型或正式前端联调；不提交、不推送。
