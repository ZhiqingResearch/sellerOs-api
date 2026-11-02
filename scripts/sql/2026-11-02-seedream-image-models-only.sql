-- 同时调整开发库与生产库；本文件包含此前的图片模型停用 SQL，无需再执行旧 SQL。
-- 保留 Seedream 5.0 Lite / Pro 的开放通道与官方直连，给车泰斗和局部重绘新增相同四种配置。
-- 新增分类价格：Lite 10 积分/张，Pro 15 积分/张（执行时从各库源配置复制）。
-- 已存在的同名分类配置仅重新启用，保留其自定义配置和价格。
-- 局部重绘仅启用 ZQ-Image-Ultra-Backup；后端按 LOCAL_REDRAW 分类查询，不固定模型名称。
-- 执行前核对两个库各有四种可用源模型；此 SQL 不触发生成。

SET NAMES utf8mb4;
START TRANSACTION;

-- selleros_api_dev：新增车泰斗和局部重绘四种模型，配置与价格复制自本库普通生图分类。
INSERT INTO `selleros_api_dev`.`AiGatewayModel` (
  `publicId`, `category`, `displayName`, `modality`, `execMode`,
  `gatewayConfig`, `quoteConfig`, `priceMultiplier`, `fixedCredits`,
  `gatewayActive`, `enabled`, `sortOrder`, `syncedAt`, `createdAt`, `updatedAt`
)
SELECT
  s.`publicId`, c.`category`, s.`displayName`, s.`modality`, s.`execMode`,
  s.`gatewayConfig`, s.`quoteConfig`, s.`priceMultiplier`, s.`fixedCredits`,
  s.`gatewayActive`, 1, s.`sortOrder`, s.`syncedAt`, NOW(3), NOW(3)
FROM `selleros_api_dev`.`AiGatewayModel` s
CROSS JOIN (
  SELECT 'CHETAIDOU_IMAGE' AS `category`
  UNION ALL SELECT 'LOCAL_REDRAW'
) c
WHERE s.`category` = 'IMAGE_GENERATION'
  AND s.`modality` = 'IMAGE'
  AND s.`gatewayActive` = 1
  AND s.`publicId` IN ('ZQ-Image-3', 'ZQ-Image-3-Backup', 'ZQ-Image-Ultra', 'ZQ-Image-Ultra-Backup')
ON DUPLICATE KEY UPDATE
  `enabled` = 1, `updatedAt` = NOW(3);

-- 所有图片分类仅保留这四种模型，包括新增的车泰斗和局部重绘配置。
UPDATE `selleros_api_dev`.`AiGatewayModel`
SET `enabled` = CASE
      WHEN `category` = 'LOCAL_REDRAW' THEN
        CASE WHEN `publicId` = 'ZQ-Image-Ultra-Backup' AND `gatewayActive` = 1 THEN 1 ELSE 0 END
      WHEN `publicId` IN ('ZQ-Image-3', 'ZQ-Image-3-Backup', 'ZQ-Image-Ultra', 'ZQ-Image-Ultra-Backup')
        AND `gatewayActive` = 1 THEN 1
      ELSE 0
    END,
    `updatedAt` = NOW(3)
WHERE `modality` = 'IMAGE';

-- selleros_api_prod：新增车泰斗和局部重绘四种模型，配置与价格复制自本库普通生图分类。
INSERT INTO `selleros_api_prod`.`AiGatewayModel` (
  `publicId`, `category`, `displayName`, `modality`, `execMode`,
  `gatewayConfig`, `quoteConfig`, `priceMultiplier`, `fixedCredits`,
  `gatewayActive`, `enabled`, `sortOrder`, `syncedAt`, `createdAt`, `updatedAt`
)
SELECT
  s.`publicId`, c.`category`, s.`displayName`, s.`modality`, s.`execMode`,
  s.`gatewayConfig`, s.`quoteConfig`, s.`priceMultiplier`, s.`fixedCredits`,
  s.`gatewayActive`, 1, s.`sortOrder`, s.`syncedAt`, NOW(3), NOW(3)
FROM `selleros_api_prod`.`AiGatewayModel` s
CROSS JOIN (
  SELECT 'CHETAIDOU_IMAGE' AS `category`
  UNION ALL SELECT 'LOCAL_REDRAW'
) c
WHERE s.`category` = 'IMAGE_GENERATION'
  AND s.`modality` = 'IMAGE'
  AND s.`gatewayActive` = 1
  AND s.`publicId` IN ('ZQ-Image-3', 'ZQ-Image-3-Backup', 'ZQ-Image-Ultra', 'ZQ-Image-Ultra-Backup')
ON DUPLICATE KEY UPDATE
  `enabled` = 1, `updatedAt` = NOW(3);

-- 所有图片分类仅保留这四种模型，包括新增的车泰斗和局部重绘配置。
UPDATE `selleros_api_prod`.`AiGatewayModel`
SET `enabled` = CASE
      WHEN `category` = 'LOCAL_REDRAW' THEN
        CASE WHEN `publicId` = 'ZQ-Image-Ultra-Backup' AND `gatewayActive` = 1 THEN 1 ELSE 0 END
      WHEN `publicId` IN ('ZQ-Image-3', 'ZQ-Image-3-Backup', 'ZQ-Image-Ultra', 'ZQ-Image-Ultra-Backup')
        AND `gatewayActive` = 1 THEN 1
      ELSE 0
    END,
    `updatedAt` = NOW(3)
WHERE `modality` = 'IMAGE';

COMMIT;

-- 核验：每个库应返回 17 行：四个分类各 4 种模型，局部重绘仅 1 种模型。
SELECT 'dev' AS `环境`, `category`, `publicId`, `displayName`, `fixedCredits`
FROM `selleros_api_dev`.`AiGatewayModel`
WHERE `modality` = 'IMAGE' AND `enabled` = 1 AND `gatewayActive` = 1
UNION ALL
SELECT 'prod' AS `环境`, `category`, `publicId`, `displayName`, `fixedCredits`
FROM `selleros_api_prod`.`AiGatewayModel`
WHERE `modality` = 'IMAGE' AND `enabled` = 1 AND `gatewayActive` = 1
ORDER BY `环境`, `category`, `publicId`;
