-- Rename StoryboardImage -> StoryboardVideo, add async generation status fields

ALTER TABLE `StoryboardImage` DROP FOREIGN KEY `StoryboardImage_storyboardId_fkey`;

RENAME TABLE `StoryboardImage` TO `StoryboardVideo`;

ALTER TABLE `StoryboardVideo`
  MODIFY COLUMN `url` VARCHAR(1000) NULL,
  ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATING',
  ADD COLUMN `taskId` VARCHAR(255) NULL,
  ADD COLUMN `errorMessage` TEXT NULL;

ALTER TABLE `StoryboardVideo`
  ADD CONSTRAINT `StoryboardVideo_storyboardId_fkey`
  FOREIGN KEY (`storyboardId`) REFERENCES `Storyboard`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
