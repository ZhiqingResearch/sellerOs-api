-- 视频一口价可空与预估成本上下限（2026-10-12）
-- 第一步先执行此结构 SQL，保留原一口价和模型倍率，不改现有扣费。
-- 然后 npx prisma generate && npm run build 并发布新代码。
-- 最后执行 2026-10-12-video-estimate-costs.sql 仅补预估成本，模型状态/倍率/已有积分保留。
-- ALTER TABLE 隐式提交；整份在同一目标库连接执行，遇错停止，不使用 mysql --force。
-- 可以重复执行，已存在的成本字段跳过。

ALTER TABLE AiGatewayVideoFixedPrice
  MODIFY COLUMN creditsPerSec DECIMAL(8, 2) NULL;

SET @video_cost_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiGatewayVideoFixedPrice' AND COLUMN_NAME = 'costMinCny'),
  'SELECT 1',
  'ALTER TABLE AiGatewayVideoFixedPrice ADD COLUMN costMinCny DECIMAL(12, 6) NULL'
);
PREPARE video_cost_statement FROM @video_cost_ddl;
EXECUTE video_cost_statement;
DEALLOCATE PREPARE video_cost_statement;

SET @video_cost_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiGatewayVideoFixedPrice' AND COLUMN_NAME = 'costPerRequest'),
  'SELECT 1',
  'ALTER TABLE AiGatewayVideoFixedPrice ADD COLUMN costPerRequest TINYINT(1) NOT NULL DEFAULT 0'
);
PREPARE video_cost_statement FROM @video_cost_ddl;
EXECUTE video_cost_statement;
DEALLOCATE PREPARE video_cost_statement;

SET @video_cost_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiGatewayVideoFixedPrice' AND COLUMN_NAME = 'costMaxCny'),
  'SELECT 1',
  'ALTER TABLE AiGatewayVideoFixedPrice ADD COLUMN costMaxCny DECIMAL(12, 6) NULL'
);
PREPARE video_cost_statement FROM @video_cost_ddl;
EXECUTE video_cost_statement;
DEALLOCATE PREPARE video_cost_statement;

