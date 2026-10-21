-- 视频预估成本补齐（2026-10-12）：保留 UAT AiGatewayVideoFixedPrice_copy1 原 57 个档位键。
-- 先执行 2026-10-12-video-pricing-schema.sql、生成 Prisma Client 并发布新代码，再执行本文件。
-- 来源：SellerOS积分 (1).xlsx / 功能积分定额扣除；sourceRow 为对应行号。
-- 包含已禁用 Grok 的 5 档成本，但不改变模型 enabled/gatewayActive，禁用模型仍不可使用。
-- 保留 Seedance 的 mode='' 通配档，使用对应参考生视频的成本，不依赖前端显式传 mode。
-- 视频编辑 480p/720p 分开保留，costPerRequest=1（元/次），不同分辨率可独立调价。
-- Kling O3 adaptive 亦为元/次；其他档位 costPerRequest=0（元/秒）。
-- 不合并分辨率、不新增 flat 档；固定成本上下限相同，区间展示 minimum/maximum_credits。
-- 本文件仅补成本：不修改模型倍率、启用状态或已有一口价积分，不操作 copy1 备份表。
-- 原正式表为空时新增对应档位，一口价初始为 NULL；已有记录仅更新成本和按次标记。
-- 仅匹配目标库中已有 VIDEO 目录行，不创建模型；缺少模型会在末尾核验中列出。
-- 重复执行将重新应用本次 Excel 成本；其他档位保留。整份在同一连接执行，遇错 ROLLBACK。
-- JOIN 显式统一排序规则，兼容现有表 unicode_ci 与数据库默认 0900_ai_ci 混用。

DROP TEMPORARY TABLE IF EXISTS video_costs_20261012;
CREATE TEMPORARY TABLE video_costs_20261012 (
  publicId VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL,
  mode VARCHAR(50) NOT NULL,
  resolution VARCHAR(50) NOT NULL,
  costMinCny DECIMAL(12, 6) NOT NULL,
  costMaxCny DECIMAL(12, 6) NOT NULL,
  costPerRequest TINYINT(1) NOT NULL,
  sourceRow INT NOT NULL,
  PRIMARY KEY (publicId, category, mode, resolution)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO video_costs_20261012
  (publicId, category, mode, resolution, costMinCny, costMaxCny, costPerRequest, sourceRow)
VALUES
  ('sourcing-gemini-omni-1-1-flash-i2v', 'NORMAL', '', '1080p', 0.273, 0.273, 0, 77),
  ('sourcing-gemini-omni-1-1-flash-i2v', 'NORMAL', '', '360p', 0.273, 0.273, 0, 54),
  ('sourcing-gemini-omni-1-1-flash-i2v', 'NORMAL', '', '720p', 0.273, 0.273, 0, 76),
  ('sourcing-gemini-omni-1-1-flash-reference', 'REFERENCE', '', '1080p', 0.259, 0.259, 0, 63),
  ('sourcing-gemini-omni-1-1-flash-reference', 'REFERENCE', '', '360p', 0.259, 0.259, 0, 61),
  ('sourcing-gemini-omni-1-1-flash-reference', 'REFERENCE', '', '720p', 0.259, 0.259, 0, 62),
  ('sourcing-grok-imagine-1-5-i2v', 'NORMAL', '', '480p', 1.12, 1.12, 0, 31),
  ('sourcing-grok-imagine-1-5-i2v', 'NORMAL', '', '720p', 1.98, 1.98, 0, 32),
  ('sourcing-grok-imagine-i2v', 'NORMAL', '', '720p', 0.98, 0.98, 0, 21),
  ('sourcing-grok-imagine-v2v', 'REFERENCE', '', '480p', 0.714, 0.714, 0, 64),
  ('sourcing-grok-imagine-v2v', 'REFERENCE', '', '720p', 1.596, 1.596, 0, 65),
  ('sourcing-kling-o3-video-edit', 'REFERENCE', '', 'adaptive', 8.82, 8.82, 1, 39),
  ('sourcing-kling-v2-6-motion-control', 'MOTION_CONTROL', 'motion_control', '1080p', 0.7, 0.7, 0, 99),
  ('sourcing-kling-v2-6-motion-control', 'MOTION_CONTROL', 'motion_control', '720p', 0.5, 0.5, 0, 98),
  ('sourcing-kling-v3-turbo-i2v', 'NORMAL', '', '1080p', 1.568, 1.568, 0, 49),
  ('sourcing-kling-v3-turbo-i2v', 'NORMAL', '', '720p', 1.568, 1.568, 0, 47),
  ('sourcing-minimax-h3-reference', 'REFERENCE', '', '1080p', 0.5, 0.5, 0, 75),
  ('sourcing-minimax-h3-reference', 'REFERENCE', '', '480p', 0.1, 0.1, 0, 73),
  ('sourcing-minimax-h3-reference', 'REFERENCE', '', '720p', 0.1, 0.1, 0, 74),
  ('sourcing-seedance-2-5-i2v', 'NORMAL', '', '480p', 1.876, 1.876, 0, 44),
  ('sourcing-seedance-2-5-i2v', 'NORMAL', '', '720p', 1.876, 1.876, 0, 46),
  ('sourcing-seedance-2-5-reference', 'REFERENCE', '', '480p', 1.867, 1.867, 0, 78),
  ('sourcing-seedance-2-5-reference', 'REFERENCE', '', '720p', 1.867, 1.867, 0, 79),
  ('sourcing-seedance-2-5-reference', 'REFERENCE', 'reference_to_video', '480p', 1.867, 1.867, 0, 78),
  ('sourcing-seedance-2-5-reference', 'REFERENCE', 'reference_to_video', '720p', 1.867, 1.867, 0, 79),
  ('sourcing-seedance-2-5-reference', 'REFERENCE', 'video_to_video', '480p', 9.38, 9.38, 1, 82),
  ('sourcing-seedance-2-5-reference', 'REFERENCE', 'video_to_video', '720p', 9.38, 9.38, 1, 83),
  ('sourcing-seedance-fast-i2v', 'NORMAL', '', '480p', 0.714, 0.714, 0, 41),
  ('sourcing-seedance-fast-i2v', 'NORMAL', '', '720p', 1.596, 1.596, 0, 43),
  ('sourcing-seedance-fast-reference', 'REFERENCE', '', '480p', 0.714, 0.714, 0, 66),
  ('sourcing-seedance-fast-reference', 'REFERENCE', '', '720p', 1.596, 1.596, 0, 67),
  ('sourcing-seedance-mini-i2v', 'NORMAL', '', '1080p-sr', 1.694, 1.694, 0, 29),
  ('sourcing-seedance-mini-i2v', 'NORMAL', '', '1440p-sr', 1.694, 1.694, 0, 30),
  ('sourcing-seedance-mini-i2v', 'NORMAL', '', '480p', 0.784, 0.833, 0, 26),
  ('sourcing-seedance-mini-i2v', 'NORMAL', '', '720p', 1.694, 1.694, 0, 27),
  ('sourcing-seedance-mini-i2v', 'NORMAL', '', '720p-sr', 0.784, 0.829, 0, 28),
  ('sourcing-seedance-mini-reference', 'REFERENCE', '', '1080p-sr', 1.694, 1.694, 0, 71),
  ('sourcing-seedance-mini-reference', 'REFERENCE', '', '1440p-sr', 1.694, 1.694, 0, 72),
  ('sourcing-seedance-mini-reference', 'REFERENCE', '', '480p', 0.784, 0.784, 0, 68),
  ('sourcing-seedance-mini-reference', 'REFERENCE', '', '720p', 1.694, 1.694, 0, 70),
  ('sourcing-seedance-mini-reference', 'REFERENCE', '', '720p-sr', 0.784, 0.784, 0, 69),
  ('sourcing-veo-fast-i2v', 'NORMAL', '', '1080p', 1.68, 1.68, 0, 52),
  ('sourcing-veo-fast-i2v', 'NORMAL', '', '720p', 1.4, 1.4, 0, 51),
  ('sourcing-veo-fast-reference', 'REFERENCE', '', '1080p', 5.6, 5.6, 0, 81),
  ('sourcing-veo-fast-reference', 'REFERENCE', '', '720p', 5.6, 5.6, 0, 80),
  ('sourcing-volcengine-seedance-2-0-fast', 'NORMAL', '', '480p', 0.37, 0.37, 0, 87),
  ('sourcing-volcengine-seedance-2-0-fast', 'NORMAL', '', '720p', 0.8, 0.8, 0, 92),
  ('sourcing-volcengine-seedance-2-0-fast', 'REFERENCE', '', '480p', 0.37, 0.37, 0, 91),
  ('sourcing-volcengine-seedance-2-0-fast', 'REFERENCE', '', '720p', 0.8, 0.8, 0, 95),
  ('sourcing-volcengine-seedance-2-0-mini', 'NORMAL', '', '480p', 0.23, 0.23, 0, 86),
  ('sourcing-volcengine-seedance-2-0-mini', 'NORMAL', '', '720p', 0.5, 0.5, 0, 93),
  ('sourcing-volcengine-seedance-2-0-mini', 'REFERENCE', '', '480p', 0.23, 0.23, 0, 90),
  ('sourcing-volcengine-seedance-2-0-mini', 'REFERENCE', '', '720p', 0.5, 0.5, 0, 96),
  ('sourcing-volcengine-seedance-2-5', 'NORMAL', '', '480p', 0.67, 0.67, 0, 88),
  ('sourcing-volcengine-seedance-2-5', 'NORMAL', '', '720p', 1.51, 1.51, 0, 94),
  ('sourcing-volcengine-seedance-2-5', 'REFERENCE', '', '480p', 0.67, 0.67, 0, 89),
  ('sourcing-volcengine-seedance-2-5', 'REFERENCE', '', '720p', 1.51, 1.51, 0, 97);

START TRANSACTION;

INSERT INTO AiGatewayVideoFixedPrice
  (publicId, category, mode, resolution, creditsPerSec, costMinCny, costMaxCny, costPerRequest, createdAt, updatedAt)
SELECT cost.publicId, cost.category, cost.mode, cost.resolution,
  NULL, cost.costMinCny, cost.costMaxCny, cost.costPerRequest, NOW(), NOW()
FROM video_costs_20261012 AS cost
INNER JOIN AiGatewayModel AS model
  ON model.publicId = cost.publicId COLLATE utf8mb4_unicode_ci
 AND model.category = cost.category COLLATE utf8mb4_unicode_ci
WHERE model.modality = 'VIDEO'
ON DUPLICATE KEY UPDATE
  costMinCny = VALUES(costMinCny),
  costMaxCny = VALUES(costMaxCny),
  costPerRequest = VALUES(costPerRequest),
  updatedAt = NOW();

COMMIT;

-- 核验：资料应为 57 档，其中 3 档按次成本；两条视频编辑保留不同分辨率。
SELECT COUNT(*) AS configuredTiers, SUM(costPerRequest) AS perRequestTiers
FROM video_costs_20261012;

-- 核验：目标库缺少对应视频模型时列出，不会创建模型或孤立价格行。
SELECT cost.publicId, cost.category, cost.sourceRow
FROM video_costs_20261012 AS cost
LEFT JOIN AiGatewayModel AS model
  ON model.publicId = cost.publicId COLLATE utf8mb4_unicode_ci
 AND model.category = cost.category COLLATE utf8mb4_unicode_ci
 AND model.modality = 'VIDEO'
WHERE model.id IS NULL;

-- 核验：档位、成本、一口价与模型启用状态；禁用模型应保持原状态。
SELECT price.publicId, price.category, price.mode, price.resolution,
  price.creditsPerSec, price.costMinCny, price.costMaxCny, price.costPerRequest,
  model.enabled, model.gatewayActive
FROM AiGatewayVideoFixedPrice AS price
INNER JOIN video_costs_20261012 AS cost
  ON price.publicId = cost.publicId COLLATE utf8mb4_unicode_ci
 AND price.category = cost.category COLLATE utf8mb4_unicode_ci
 AND price.mode = cost.mode COLLATE utf8mb4_unicode_ci
 AND price.resolution = cost.resolution COLLATE utf8mb4_unicode_ci
INNER JOIN AiGatewayModel AS model
  ON model.publicId = price.publicId COLLATE utf8mb4_unicode_ci
 AND model.category = price.category COLLATE utf8mb4_unicode_ci
ORDER BY price.publicId, price.category, price.mode, price.resolution;

DROP TEMPORARY TABLE video_costs_20261012;
