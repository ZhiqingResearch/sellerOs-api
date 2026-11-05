-- MySQL：截图红框中的 Seedream / Seedance 系列只展示官方直连通道。
-- 前提：目标库已登记对应官方模型；可先运行文件末尾的 SELECT 核对。
-- 生图覆盖 IMAGE_GENERATION / AI_SPLIT / PORTRAIT；视频覆盖 NORMAL / REFERENCE。
-- 仅调整 enabled，不修改模型能力、gatewayActive、倍率和一口价，不改历史任务。
-- 官方直连指 AI 网关上游直连官方供应商，平台提交仍走现有 AI 网关。

START TRANSACTION;

-- Seedream 5.0 Lite / Pro：启用官方通道。
UPDATE `AiGatewayModel`
SET `enabled` = 1, `updatedAt` = NOW()
WHERE `modality` = 'IMAGE'
  AND `category` IN ('IMAGE_GENERATION', 'AI_SPLIT', 'PORTRAIT')
  AND `gatewayActive` = 1
  AND `publicId` IN ('ZQ-Image-3-Backup', 'ZQ-Image-Ultra-Backup');

-- Seedream 5.0 Lite / Pro：停用开放通道。
UPDATE `AiGatewayModel`
SET `enabled` = 0, `updatedAt` = NOW()
WHERE `modality` = 'IMAGE'
  AND `category` IN ('IMAGE_GENERATION', 'AI_SPLIT', 'PORTRAIT')
  AND `publicId` IN ('ZQ-Image-3', 'ZQ-Image-Ultra');

-- Seedance 2.0 Mini / 2.0 Fast / 2.5：启用官方通道。
UPDATE `AiGatewayModel`
SET `enabled` = 1, `updatedAt` = NOW()
WHERE `modality` = 'VIDEO'
  AND `category` IN ('NORMAL', 'REFERENCE')
  AND `gatewayActive` = 1
  AND `publicId` IN (
    'sourcing-volcengine-seedance-2-0-mini',
    'sourcing-volcengine-seedance-2-0-fast',
    'sourcing-volcengine-seedance-2-5'
  );

-- Seedance 三种型号：停用图生/首尾帧及参考模式的开放通道。
UPDATE `AiGatewayModel`
SET `enabled` = 0, `updatedAt` = NOW()
WHERE `modality` = 'VIDEO'
  AND `category` IN ('NORMAL', 'REFERENCE')
  AND `publicId` IN (
    'sourcing-seedance-mini-i2v',
    'sourcing-seedance-fast-i2v',
    'sourcing-seedance-2-5-i2v',
    'sourcing-seedance-mini-reference',
    'sourcing-seedance-fast-reference',
    'sourcing-seedance-2-5-reference'
  );

-- 额外停用用户指定的三个视频模型。
UPDATE `AiGatewayModel`
SET `enabled` = 0, `updatedAt` = NOW()
WHERE `modality` = 'VIDEO'
  AND `publicId` IN (
    'sourcing-veo-fast-reference',
    'sourcing-gemini-omni-1-1-flash-i2v',
    'sourcing-gemini-omni-1-1-flash-reference'
  );

COMMIT;

-- 核验：官方通道应 enabled=1；对应开放通道和额外指定的三个视频模型应 enabled=0。
-- 官方项还需 gatewayActive=1 才会出现在可选列表中；目标库缺行时须先上架模型。
SELECT `id`, `category`, `publicId`, `displayName`, `enabled`, `gatewayActive`
FROM `AiGatewayModel`
WHERE (
  `modality` = 'IMAGE'
  AND `category` IN ('IMAGE_GENERATION', 'AI_SPLIT', 'PORTRAIT')
  AND `publicId` IN (
    'ZQ-Image-3', 'ZQ-Image-Ultra',
    'ZQ-Image-3-Backup', 'ZQ-Image-Ultra-Backup'
  )
) OR (
  `modality` = 'VIDEO'
  AND `category` IN ('NORMAL', 'REFERENCE')
  AND `publicId` IN (
    'sourcing-volcengine-seedance-2-0-mini',
    'sourcing-volcengine-seedance-2-0-fast',
    'sourcing-volcengine-seedance-2-5',
    'sourcing-seedance-mini-i2v',
    'sourcing-seedance-fast-i2v',
    'sourcing-seedance-2-5-i2v',
    'sourcing-seedance-mini-reference',
    'sourcing-seedance-fast-reference',
    'sourcing-seedance-2-5-reference',
    'sourcing-veo-fast-reference',
    'sourcing-gemini-omni-1-1-flash-i2v',
    'sourcing-gemini-omni-1-1-flash-reference'
  )
)
ORDER BY `category`, `publicId`;
