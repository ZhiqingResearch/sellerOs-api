# 正副标题配置复查

新任务单独使用 `scripts/asin-highlights-review.ts`，不重跑旧 Listing 内容矛盾审计。

- 输入固定为 `scripts/data/链接审查_配置审查 (1).csv`，筛选“审查结果=不匹配 且备注包含未识别”：362 源行，345 个站点-ASIN。
- 用户最终确认按 ASIN 比对。原备注 `正确配置：` 后的组合保留内存与硬盘配对；同 ASIN 多组配置完整命中一组才算匹配，不把不同组合的两个容量拼接。
- `/highlights` 请求 `{url}`，沿用 CRAWLER_API_TOKEN。爬虫严格串行，单次超时60秒，忙碌和网络暂断自动退避到每5分钟；400等明确错误记失败，不掩盖为配置结论。没有AI请求，内存与存储使用带来源引用的规则提取。显存/GDDR、云盘和升级上限不冒充当前配置；缺失标“无法判断”待复查。
- 标题/亮点存回旧 `.state/snapshots/<站点-ASIN>-audit.json` 的 `listing.title/second_title`，同时更新已有核心 `core/<站点-ASIN>.json` 的 `listing`、`currentListing`。`highlights` 保存完整响应、URL和抓取时间；原始审计数据保存在同文件 `originalAuditSnapshot`，raw/五点/描述/库存等保留。原审计导出可继续匹配原快照证据；历史矛盾结果不冒充对新标题的重审。
- 无旧 audit 快照时使用 `<站点-ASIN>-highlights.json`，不伪造一次 audit 抓取。
- 工作目录只有 `scripts/data/asin-highlights-review/current-results.csv`（逐条当前结果）、`results.csv`（原表映射）和隐藏 `.state`（任务、进度、日志、校验）。输出逐条更新，原输入与旧 results.csv 不改动。

```powershell
node -r ts-node/register scripts/asin-highlights-review.ts --mode plan
node -r ts-node/register scripts/asin-highlights-review.ts --mode run --limit 3
node -r ts-node/register scripts/asin-highlights-review.ts --mode run
node -r ts-node/register scripts/asin-highlights-review.ts --mode run --retry-failed
node -r ts-node/register scripts/asin-highlights-review.ts --mode export
node -r ts-node/register scripts/asin-highlights-review.ts --mode recompare # 仅离线重算已有亮点
node -r ts-node/register scripts/verify-highlights-review.ts
node -r ts-node/register scripts/asin-audit/highlights-review.test.ts
```

暂停：创建 `.state/pause.requested`，当前请求完成后停止；续跑前移除该标记。异常退出的锁需要先核实PID和其他爬虫进程，禁止盲删锁或第二实例。

全部处理后先执行校验器，检查未处理、失败、无法判断，并人工抽查真实不匹配和标题变更案例。完成审查前不写线上。最终同步按当前线上站点+ASIN匹配，仅更新目标行的标题、商品亮点、审查结果、备注四列；保留筛选、其他列、既有人工变更，失败不覆盖。同步后全字段回读验证。
