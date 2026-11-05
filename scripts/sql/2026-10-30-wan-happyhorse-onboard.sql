-- MySQL：新增 Wan2.7-Image-Pro / Happyhorse-1.1 官方直连模型。
-- 在目标数据库执行。重复执行跳过已有记录，不覆盖现有配置。
-- 网关实际账单 × 1.5，未配置固定积分价；视频成本仅用于报价展示。
-- 图片加入普通生图、AI 拆图、人像、车泰斗；视频加入普通视频、参考视频。
-- 局部重绘、动作复刻、美妆、客户分镜由后端自动选择单模型，不新增。
-- 同步加入企业模型配置可选目录，不修改企业已保存的默认模型或可选范围。
-- gatewayConfig 仅放空对象占位，能力快照通过现有同步脚本拉取，避免把大段 JSON 写进 SQL。
-- 执行本 SQL 后，在连接同一目标库和对应网关的后端环境中运行：
-- npm run sync:ai-gateway-models -- --publicId=wan2.7-image-pro --modality=image
-- npm run sync:ai-gateway-models -- --publicId=happyhorse-1.1 --modality=video

SET NAMES utf8mb4;
START TRANSACTION;

INSERT INTO `AiGatewayModel` (
  `publicId`, `category`, `displayName`, `modality`, `execMode`,
  `gatewayConfig`, `priceMultiplier`, `fixedCredits`,
  `gatewayActive`, `enabled`, `sortOrder`, `syncedAt`, `createdAt`, `updatedAt`
) VALUES
  ('wan2.7-image-pro', 'IMAGE_GENERATION', 'Wan2.7-Image-Pro（官方直连）', 'IMAGE', 'ASYNC',
   JSON_OBJECT(), 1.50, NULL, 1, 1, 110, NULL, NOW(3), NOW(3)),
  ('wan2.7-image-pro', 'AI_SPLIT', 'Wan2.7-Image-Pro（官方直连）', 'IMAGE', 'ASYNC',
   JSON_OBJECT(), 1.50, NULL, 1, 1, 30, NULL, NOW(3), NOW(3)),
  ('wan2.7-image-pro', 'PORTRAIT', 'Wan2.7-Image-Pro（官方直连）', 'IMAGE', 'ASYNC',
   JSON_OBJECT(), 1.50, NULL, 1, 1, 100, NULL, NOW(3), NOW(3)),
  ('wan2.7-image-pro', 'CHETAIDOU_IMAGE', 'Wan2.7-Image-Pro（官方直连）', 'IMAGE', 'ASYNC',
   JSON_OBJECT(), 1.50, NULL, 1, 1, 110, NULL, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'NORMAL', 'Happyhorse-1.1（官方直连）', 'VIDEO', 'ASYNC',
   JSON_OBJECT(), 1.50, NULL, 1, 1, 130, NULL, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'REFERENCE', 'Happyhorse-1.1（官方直连）', 'VIDEO', 'ASYNC',
   JSON_OBJECT(), 1.50, NULL, 1, 1, 140, NULL, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `id` = `AiGatewayModel`.`id`;

INSERT INTO `AiGatewayVideoFixedPrice` (
  `publicId`, `category`, `mode`, `resolution`, `creditsPerSec`,
  `costMinCny`, `costMaxCny`, `costPerRequest`, `createdAt`, `updatedAt`
) VALUES
  ('happyhorse-1.1', 'NORMAL', '', '480p', NULL, 0.45, 0.45, 0, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'NORMAL', '', '720p', NULL, 0.90, 0.90, 0, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'NORMAL', '', '1080p', NULL, 1.20, 1.20, 0, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'REFERENCE', '', '480p', NULL, 0.45, 0.45, 0, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'REFERENCE', '', '720p', NULL, 0.90, 0.90, 0, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'REFERENCE', '', '1080p', NULL, 1.20, 1.20, 0, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `id` = `AiGatewayVideoFixedPrice`.`id`;

INSERT INTO `AiModel` (`code`, `name`, `kind`, `active`, `sortOrder`, `createdAt`, `updatedAt`) VALUES
  ('wan2.7-image-pro', 'Wan2.7-Image-Pro（官方直连）', 'IMAGE', 1, 5, NOW(3), NOW(3)),
  ('happyhorse-1.1', 'Happyhorse-1.1（官方直连）', 'VIDEO', 1, 22, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `id` = `AiModel`.`id`;

COMMIT;
