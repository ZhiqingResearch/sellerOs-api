-- Switch MaterialImageVariant to async generation pipeline (nullable url + status + errorMessage)

ALTER TABLE `MaterialImageVariant`
  MODIFY COLUMN `url` VARCHAR(1000) NULL,
  ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATING',
  ADD COLUMN `errorMessage` TEXT NULL;

-- 已有行视为已完成，避免被前端误读成 GENERATING
UPDATE `MaterialImageVariant` SET `status` = 'SUCCESS' WHERE `url` IS NOT NULL;
