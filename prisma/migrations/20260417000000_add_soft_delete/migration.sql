-- Add deletedAt column for soft delete on customer-related models

ALTER TABLE `Customer` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Account` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Avatar` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Voice` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Project` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Source` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Strategy` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Production` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Script` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `CopyWriting` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `Storyboard` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `MaterialImage` ADD COLUMN `deletedAt` DATETIME(3) NULL;
