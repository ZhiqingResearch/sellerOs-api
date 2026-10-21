-- 把异步深度调研状态挂到 Source 上：新增 query / status / errorMessage 三列
-- 既有数据默认 status='SUCCESS'，对 HOT_TOPIC / CLIENT_BRIEF 无影响

ALTER TABLE `Source`
  ADD COLUMN `query` TEXT NULL,
  ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN `errorMessage` TEXT NULL;
