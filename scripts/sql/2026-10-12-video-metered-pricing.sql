-- 视频切换按量计费（此前确认的调价步骤，2026-10-12）。
-- 本文件不属于「仅补预估成本」步骤；仅当要应用此前确认的 1.5 倍按量计费时执行。
-- 先执行 2026-10-12-video-pricing-schema.sql，并生成 Prisma Client、发布新代码。
-- 可另执行 2026-10-12-video-estimate-costs.sql 补成本；该成本文件不调整倍率或已有一口价。
-- 执行前导出原倍率和一口价作为恢复依据；整份同一连接执行，遇错 ROLLBACK。
-- 实时读取配置，尚未结算任务亦受影响；失败终态若有实际网关费用也会计费。
-- JOIN 显式统一排序规则，兼容现有表 unicode_ci 与 0900_ai_ci 混用。

START TRANSACTION;

UPDATE AiGatewayModel
SET priceMultiplier = 1.50, updatedAt = NOW()
WHERE modality = 'VIDEO' AND priceMultiplier <> 1.50;

UPDATE AiGatewayVideoFixedPrice AS price
INNER JOIN AiGatewayModel AS model
  ON model.publicId = price.publicId COLLATE utf8mb4_unicode_ci
 AND model.category = price.category COLLATE utf8mb4_unicode_ci
SET price.creditsPerSec = NULL, price.updatedAt = NOW()
WHERE model.modality = 'VIDEO' AND price.creditsPerSec IS NOT NULL;

COMMIT;

SELECT model.publicId, model.category, model.priceMultiplier, price.creditsPerSec
FROM AiGatewayModel AS model
LEFT JOIN AiGatewayVideoFixedPrice AS price
  ON model.publicId = price.publicId COLLATE utf8mb4_unicode_ci
 AND model.category = price.category COLLATE utf8mb4_unicode_ci
WHERE model.modality = 'VIDEO'
  AND (model.priceMultiplier <> 1.50 OR price.creditsPerSec IS NOT NULL);
