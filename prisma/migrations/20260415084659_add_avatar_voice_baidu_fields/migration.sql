/*
  Warnings:

  - A unique constraint covering the columns `[figureId]` on the table `Avatar` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[perId]` on the table `Voice` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `Avatar` ADD COLUMN `figureId` VARCHAR(191) NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'WAIT',
    ADD COLUMN `thumbnailUrl` VARCHAR(191) NULL,
    ADD COLUMN `trainingUrl` VARCHAR(191) NULL,
    MODIFY `description` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Voice` ADD COLUMN `exampleAudioUrl` VARCHAR(191) NULL,
    ADD COLUMN `perId` VARCHAR(191) NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'PREPARING',
    ADD COLUMN `trainingUrl` VARCHAR(191) NULL,
    MODIFY `description` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Avatar_figureId_key` ON `Avatar`(`figureId`);

-- CreateIndex
CREATE UNIQUE INDEX `Voice_perId_key` ON `Voice`(`perId`);
