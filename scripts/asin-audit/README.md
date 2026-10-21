# ASIN Listing 批量审查

独立命令行脚本，读取「全量 CSV + 核心 ASIN Excel」，直接调用项目爬虫和 AI Gateway，不启动 Nest 应用、不写业务数据库、不执行完整 ASIN 审计/评分，不扣平台用户积分。上游爬虫和模型调用可能产生费用。

## 执行

在仓库根目录运行，使用现有 node_modules（无需新增依赖）：

```powershell
# 只核对输入并建立任务清单，不调用 API
node -r ts-node/register scripts/asin-listing-audit.ts --all-file 'scripts/data/链接审查_配置审查.csv' --core-file 'scripts/data/刷单ASIN.xlsx' --mode plan

# 对相同小样本分别请求 /pdp 和 /audit，记录耗时与三个文本字段是否一致
node -r ts-node/register scripts/asin-listing-audit.ts --all-file 'scripts/data/链接审查_配置审查.csv' --core-file 'scripts/data/刷单ASIN.xlsx' --mode benchmark --limit 4

# 核心/普通交替取 6 个样本；复用同目录 benchmark 中已抓取的快照
node -r ts-node/register scripts/asin-listing-audit.ts --all-file 'scripts/data/链接审查_配置审查.csv' --core-file 'scripts/data/刷单ASIN.xlsx' --mode run --limit 6

# 正式全量（显式 --all 才运行全部），可从同目录的小样本断点继续
node -r ts-node/register scripts/asin-listing-audit.ts --all-file 'scripts/data/链接审查_配置审查.csv' --core-file 'scripts/data/刷单ASIN.xlsx' --mode run --all --concurrency 1

# 重试失败项，成功项仍跳过
node -r ts-node/register scripts/asin-listing-audit.ts --all-file 'scripts/data/链接审查_配置审查.csv' --core-file 'scripts/data/刷单ASIN.xlsx' --mode run --all --retry-failed

# 仅重新汇总导出已有结果，无网络请求
node -r ts-node/register scripts/asin-listing-audit.ts --all-file 'scripts/data/链接审查_配置审查.csv' --core-file 'scripts/data/刷单ASIN.xlsx' --mode export

# 离线逻辑测试
node -r ts-node/register scripts/asin-audit/listing-audit.test.ts
```

支持 `--asins B0FJRSWWF3,B0FD38WBGS` 精确选择样本；相同 ASIN 存在多个站点时各自处理。`--out` 指定结果目录，默认 `scripts/data/asin-audit-sample-final`（已被 Git 忽略）。原始输入文件不会被修改。

从 `.env` 或 `--env-file` 读取 `CRAWLER_API_BASE_URL`、`CRAWLER_API_TOKEN`、`AI_GATEWAY_BASE_URL`、`AI_GATEWAY_API_KEY`。模型优先级为 `--model` > `ASIN_AUDIT_MODEL` > `ZQ-Think-Flash`。不向模型发送店铺、运营、备注等源表字段，只发送本次抓取的标题、五点、描述。

## 抓取策略

- 核心 ASIN 始终 `/audit`，保存完整原始返回 `raw` 和可直接读取的 `currentListing`。不筛掉 Q&A、图片 URL、A+、后台关键词、评论、产品参数或未来新增字段。
- `currentListing.isSoldOut` 对应实际爬虫 `sold_out`，保持 `true / false / null`，缺失不猜测。完整原始值仍在 `raw.sold_out`。
- **所有 ASIN 统一 `/audit`，先检查 `sold_out`**。`/pdp` 实测不返回此字段，不能据此可靠排除缺货商品，已移除原 `--ordinary-api` 和 `--fallback-audit` 参数。
- `sold_out=true` 直接标记「缺货」，跳过模型比对及复核，不生成矛盾结论；核心 ASIN 即使缺货也照常保留完整抓取数据。`false` 正常比对；缺失/无法识别时保留库存「未知」，不冒充缺货，仍按内容规则处理。
- 普通 ASIN 只持久化三项文本、售罄状态、来源和时间等元数据，不保存完整原始数据。抓取失败记失败，不输出无矛盾。
- 普通 ASIN 不走 Listing 打分页面整条链：该页面还会调用 Keepa / SellerSprite，并行请求后端 PDP，再用 audit 补图片；这些额外步骤对本次三段文本比对没有必要。
- 两条实测样本（2026-09-10）PDP 分别 14.5s、19.1s，audit 22.1s、22.1s，三项文本一致。虽然 PDP 较快，但本次需要 `sold_out`，因此统一 audit。只是小样本结果，不保证所有 ASIN 的速度或字段完整度。

## 输入和判断口径

本次输入核对：3,847 条源记录，3,555 个不同 ASIN，按站点去重后 3,557 个抓取任务；核心 434 个 ASIN 全部在全量表中。US 3,555 个任务，MX 2 个任务。源表重复行仍逐行回填。

站点先读显式 `country` / `站点` 列，其次读店铺名称中的国家码，最后用 `--country US` 兜底。核心 Excel 只读含精确 `ASIN` 表头的表，不把清洗说明、异常信息或单元格中的指令当请求。非法 ASIN、核心表独有 ASIN、异常 CSV 均在调用前报错。

标题基准是本次爬虫返回的 `TITLE`，不是 CSV 中可能过时的「标题」。只判断五点/描述是否与标题矛盾。**没有描述就只比对五点，没有五点就只比对描述，两项都有就都比对**，不会因其中一项缺失而把有效比对标为无法判断。「说明」列保留实际比对范围，「缺失字段」列仅记录事实、不阻止比对。标题没有提及的参数，以及五点与描述之间但不涉及标题的内部矛盾，都不计入本次结果。支持区分当前配置与 “up to” / 可选配置。

- **是**：找到明确冲突，逐条附标题原文、正文原文、来源字段、中文解释。脚本验证引用确实出现在相应字段，拒绝捏造证据。初判为「是」的结果额外执行一次独立模型复核，删除不同属性错比、只存在正文内部冲突等错误候选。`.state/checks/` 保留初判和复核用量。
- **否**：标题有效，且已有的五点/描述与标题未发现冲突。只获取到五点也可正常输出「否」。
- **无法判断**：缺标题、两项正文都没有有效内容，或现有文字确实无法确认；单独缺描述或五点不会触发此状态。
- **是否缺货**：独立列，按 `sold_out` 输出「是 / 否 / 未知」，替代旧列「是否售罄」。缺货时不执行模型比对，矛盾判断列填「未判断」、矛盾点留空，审查状态为「缺货」。
- **未判断**：缺货跳过、尚未处理或请求失败，另有独立缺货列及审查状态/错误说明。

语义判断由模型执行，原文可追溯，但不能保证模型零误判。审查不下载图片，也不比较 A+、评论、产品参数；核心 ASIN 这些字段完整保存供后续审计使用。图片保存的是 API 返回 URL，后续链接可能失效。

## 输出和续跑

2026-09-11 起采用抓取与比对流水线：一个抓取生产者严格串行调用爬虫，抓完并保存快照后交给 AI 队列，同时继续抓下一条。`--ai-concurrency 2`（默认 2，可选 1–4）仅控制 AI 消费者；等待队列最多 4 条，队列满时暂停领取。缺货及抓取失败直接实时写入；其余记录在 AI 完成后立即写入，结果仍按输入顺序汇总。核心完整数据在抓取成功后立即保存，无需等待 AI。退出/中断时尚未比对的快照可直接续用。`.state/runtime.json` 增加 `queuedCount`、`activeAiCount`、`aiConcurrency`；`waiting_for_ai` 表示抓取结束、等待 AI 队列完成。输出写入失败后停止领取，等待在途操作结束再释放运行锁。

| 文件                    | 内容                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `current-results.csv`   | 实时处理表：只收录已处理的站点 + ASIN，每条立即写入，含成功、缺货、失败；重试更新原行，不重复追加 |
| `results.csv`           | 最终映射表：处理结束后按站点 + ASIN 回填原表，保留原顺序、重复行和业务字段；运行中不更新          |
| `core/<站点-ASIN>.json` | 核心 ASIN 完整原始数据和 currentListing，包括售罄三态                                             |
| `.state/`               | 脚本内部缓存、逐条记录、任务清单、统计及运行锁；日常不用查看，续跑时需保留                        |

不再生成 all-rows.csv 和 core-listings.jsonl，避免重复结果造成混淆。统计按站点-ASIN 去重，结果表保留全部源行，所以两者总行数不同。
CSV 为 UTF-8 BOM，Excel 可直接打开。输出文字做公式注入防护，以公式字符开头的文本会加单引号。

**爬虫不支持并发，强制单并发（`--concurrency` 仅允许 1），benchmark 的两个接口也逐个请求。** 爬虫单次超时 60s，模型复用现有 Provider 的 300s 超时。遇到明确的「服务器正在处理其它爬虫任务」（HTTP 502，error.code=`server is busy,please wait`）或 HTTP 429，正式抓取按 30/60/120/240/300 秒退避，之后每 5 分钟串行重试，持续等待服务恢复，不因忙碌把任务记失败或停止全量；用户主动停止仍可打断等待。等待次数及下次重试时间记录在 .state/runtime.json，监控不得把此等待当作进程卡死。benchmark 和模型调用仍采用最多 12 次的忙碌重试。这类等待与普通错误重试次数分开计算。普通失败最多重试 2 次，可用 `--retries 0..5` 修改。HTTP 400/401/403/404 不自动重试。每条处理结果完成后立即落盘，抓取与 AI 可交叠执行，失败单独记录，网络错误保留 HTTP 状态。存在失败时进程退出码为 1。

同一输出目录复用本次抓取快照，不自动重新抓取；重跑会跳过已完成项（含无法判断）、缺货项和失败项，失败项需要 `--retry-failed`。若要重新抓取当前状态或重新判定，请用新 `--out`。更换输入文件、模型或抓取策略也需要新目录，脚本拒绝混入旧结果。版本 3 开始排除售罄，版本 4 支持缺描述时仅比对五点；旧版目录不能直接续跑，应另建目录以免沿用旧的比对结果。

正式抓取遇到没有 HTTP 响应的连接重置、拒绝连接、DNS 或网络不可达（ECONNRESET、ECONNREFUSED、ENOTFOUND、EAI_AGAIN、ENETUNREACH、EHOSTUNREACH），普通重试耗尽后停留在当前 ASIN，按 30/60/120/240/300 秒退避并持续每 5 分钟等待恢复，避免连接故障批量消耗后续任务。runtime 此时为 waiting_for_crawler，reason=connection_error，保留错误及 nextRetryAt。请求超时和 HTTP 错误仍按上述原有规则处理；AI 与 benchmark 不启用连接故障无限重试。用户停止可打断等待。

运行开始、每处理完一个任务及运行结束都会更新 current-results.csv 和 .state/summary.json，写入为同步原子替换；已在途的其他抓取或 AI 请求可继续。实时表只列已处理任务，按站点 + ASIN 去重；续跑保留已有结果。results.csv 仅在本次处理结束（含正常停止）或执行 --mode export 时统一映射，处理期间保留上次导出版本。单文件通过临时文件替换，避免读到半份结果。文件被 Excel 占用等原因导致写入失败时停止处理，已保存的逐条记录可用 --mode export 恢复。Excel 已打开的视图需要重新打开才能看到磁盘更新。
Ctrl+C 停止领取新任务，已领取任务结束/超时后汇总导出。`.state/run.lock` 防止多个进程同时写同目录；若进程被强制终止，确认它已退出后再删除锁，并立即执行 `--mode export` 将最近的逐条记录回填到汇总文件。该命令只读本地快照，不调用爬虫或模型。`.state/checks/` 和 `.state/snapshots/` 已完成文件可继续使用。

## AI 校验诊断与纠错（2026-09-14）

此前「AI 中转站返回的 JSON 结构不完整」也包含引用校验失败，不能据此认定 JSON 被截断。现由脚本在 JSON 解析后校验，错误明确标出初判/复核、字段路径及原因（标题引用不存在、正文引用不存在、判断与矛盾数组不一致、缺字段等）。

失败的已解析模型返回、用量、具体问题、尝试次数及阶段，写入 `.state/validation-failures/<站点-ASIN>.json`，按任务覆盖，包含对应快照哈希；本次最终成功时 `isResolved=true`。日志和 CSV 只写简短原因，不混入整段失败回答。未通过 JSON 解析或请求超时的响应不进入这份校验诊断记录，仍按原请求错误处理。

校验失败后，将上一份无效结果和具体问题作为不可信纠错数据交给模型，重新审查完整 listing，复用原 `--retries` 预算（默认最多 3 次请求/阶段），不无限追加。引用要求内容连续且位于正确来源；只兼容已有空白的排版差异（普通/窄/不换行空格、tab、换行及连续空白），不做语义模糊匹配、自动拼接，也不把失败转为“否”。通过后将引用还原成对应来源的真实原文，再复核及保存；不改变快照。不允许删词、改数字/单位、跨 bullet 或把正文当标题。提示明确内存/硬盘分别引用、不能把正文作为标题、范围包含标题配置不矛盾、补充具体型号不矛盾。正向结论仍独立复核，复核失败同样纠错。

这次修复细化原有判断规则并改进诊断，不改变输入指纹；续跑继续跳过已成功/缺货记录。最初诊断修复标记 `comparisonValidationVersion=1`，空白兼容修复后的新模型结果标记 `comparisonValidationVersion=2`。历史校验失败不会凭空产生细分原因，需要再次实际调用模型才能诊断。新增成功结果是否同步线上仍遵循现有同步规则。

默认从 scripts/data/链接审查\_配置审查.csv 和 scripts/data/刷单ASIN.xlsx 读取，可省略两个输入参数。常用命令：

```powershell
# 本地重建结果表，不调用 API
node -r ts-node/register scripts/asin-listing-audit.ts --mode export
# 用户确认开始后，从当前目录数据运行全量
node -r ts-node/register scripts/asin-listing-audit.ts --mode run --all
```

### 标题依据先行（2026-09-14）

对反复把正文当标题的失败项，可用 `--evidence-first --asins ASIN1,ASIN2 --retry-failed`。第一步只向模型发送 TITLE，拆出有含义的属性原文；脚本检查每段确在标题中，且合计覆盖标题所有文字、数字，遗漏规格会重试。第二步给每段分配编号，让模型逐编号对照全部五点/描述，不能遗漏或重复编号；标题引用由脚本根据编号回填，不允许模型从正文重新编造。正文引用仍校验来源、连续性和空白兼容。第三步对所有初判（包括无矛盾）独立复核全部标题编号，重新核对候选和正文，保留真实冲突、排除标题没写的属性。正文既有匹配句又有冲突句时不能互相抵消，复核需逐段检查遗漏。

各阶段最多按 `--retries` 重试（默认 3 次请求/阶段），不把无效结果直接改成“否”。标题提取及其用量保存在 check 的 `titleEvidence` 中，新结果 `comparisonValidationVersion=3`；失败诊断增加 `title_evidence` 阶段。新一轮直接成功时也会把相同快照的历史诊断标为已解决。已成功和缺货仍跳过，不修改输入指纹或已有快照；使用该选项时需要加载新脚本进程，不改变已在运行的进程。
