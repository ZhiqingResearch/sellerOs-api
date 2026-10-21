-- Add storyboard fields and StoryboardImage table

ALTER TABLE `Storyboard`
  ADD COLUMN `shot` TEXT NOT NULL,
  ADD COLUMN `duration` INT NOT NULL DEFAULT 4,
  ADD COLUMN `prompt` TEXT NOT NULL,
  ADD COLUMN `motion` VARCHAR(191) NOT NULL,
  ADD COLUMN `firstFrameUrl` VARCHAR(1000) NULL,
  ADD COLUMN `lastFrameUrl` VARCHAR(1000) NULL,
  ADD COLUMN `order` INT NOT NULL DEFAULT 0;

CREATE TABLE `StoryboardImage` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `url` VARCHAR(1000) NOT NULL,
  `approved` BOOLEAN NOT NULL DEFAULT false,
  `storyboardId` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StoryboardImage`
  ADD CONSTRAINT `StoryboardImage_storyboardId_fkey`
  FOREIGN KEY (`storyboardId`) REFERENCES `Storyboard`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
