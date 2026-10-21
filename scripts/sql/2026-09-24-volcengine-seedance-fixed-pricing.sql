-- 火山方舟 Seedance 系列固定一口价（积分/秒 × 分辨率档）配置 SQL
-- 对应目录上架：scripts/sql/2026-09-24-volcengine-seedance-onboard.sql（目标环境须先执行）
-- 报价单（2026-09-24，供应商=火山，状态=测试中）：成本列为火山官方锚点价（元/秒），积分列 = 积分/秒，
--   NORMAL（生视频-常规模式 图生/首尾帧）与 REFERENCE（生视频-全能参考 参考生/编辑）同价：
--   Mini  480p 0.23 元/秒 → 5 积分/秒、720p 0.50 → 10
--   Fast  480p 0.37 → 5、720p 0.80 → 10
--   2.5   480p 0.67 → 10、720p 1.51 → 20
-- 火山方舟 Seedance 2.0（base）不在报价单内：不配行，维持按量计费（网关报价 × priceMultiplier=1）。
-- mode = ''（通配）：该类别全部模式同价（含 t2v / 图生 / 首尾帧 / 参考 / 编辑）。
-- 生效口径：仅 SUCCESS 按「积分/秒 × 实际时长秒」精确扣费（exactCredits，不打折不乘倍率），
--   时长 0/缺失按 1 秒保底；失败/取消/超时不扣。扣费/预检/报价实时读库，改库即对下一笔生效。
-- 幂等：唯一键 publicId+category+mode+resolution，重复执行只刷新价格。

INSERT INTO AiGatewayVideoFixedPrice
  (publicId, category, mode, resolution, creditsPerSec, createdAt, updatedAt)
VALUES
  -- 生视频-常规模式（NORMAL）
  ('sourcing-volcengine-seedance-2-0-mini', 'NORMAL', '', '480p', 5, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-0-mini', 'NORMAL', '', '720p', 10, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-0-fast', 'NORMAL', '', '480p', 5, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-0-fast', 'NORMAL', '', '720p', 10, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-5', 'NORMAL', '', '480p', 10, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-5', 'NORMAL', '', '720p', 20, NOW(), NOW()),
  -- 生视频-全能参考（REFERENCE）
  ('sourcing-volcengine-seedance-2-0-mini', 'REFERENCE', '', '480p', 5, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-0-mini', 'REFERENCE', '', '720p', 10, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-0-fast', 'REFERENCE', '', '480p', 5, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-0-fast', 'REFERENCE', '', '720p', 10, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-5', 'REFERENCE', '', '480p', 10, NOW(), NOW()),
  ('sourcing-volcengine-seedance-2-5', 'REFERENCE', '', '720p', 20, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  creditsPerSec = VALUES(creditsPerSec),
  updatedAt     = NOW();

-- 核验：应返回 12 行，价格与上表一致；base 2.0（sourcing-volcengine-seedance-2-0）应无行（按量）
SELECT publicId, category, mode, resolution, creditsPerSec
FROM AiGatewayVideoFixedPrice
WHERE publicId IN (
  'sourcing-volcengine-seedance-2-0-mini',
  'sourcing-volcengine-seedance-2-0-fast',
  'sourcing-volcengine-seedance-2-5'
)
ORDER BY publicId, category, resolution;
