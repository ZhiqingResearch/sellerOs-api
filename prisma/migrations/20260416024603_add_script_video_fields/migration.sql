/*
  Warnings:

  - A unique constraint covering the columns `[videoTaskId]` on the table `Script` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `Script` ADD COLUMN `videoDuration` INTEGER NULL,
    ADD COLUMN `videoStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `videoTaskId` VARCHAR(191) NULL,
    ADD COLUMN `videoUrl` VARCHAR(1000) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Script_videoTaskId_key` ON `Script`(`videoTaskId`);
