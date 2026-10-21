-- Add MaterialImage fields and MaterialImageVariant table

ALTER TABLE `MaterialImage`
  ADD COLUMN `purpose` VARCHAR(200) NOT NULL,
  ADD COLUMN `ratio` VARCHAR(191) NOT NULL,
  ADD COLUMN `prompt` TEXT NOT NULL,
  ADD COLUMN `refImageUrl` VARCHAR(1000) NULL,
  ADD COLUMN `order` INT NOT NULL DEFAULT 0;

CREATE TABLE `MaterialImageVariant` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `url` VARCHAR(1000) NOT NULL,
  `approved` BOOLEAN NOT NULL DEFAULT false,
  `materialImageId` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MaterialImageVariant`
  ADD CONSTRAINT `MaterialImageVariant_materialImageId_fkey`
  FOREIGN KEY (`materialImageId`) REFERENCES `MaterialImage`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
