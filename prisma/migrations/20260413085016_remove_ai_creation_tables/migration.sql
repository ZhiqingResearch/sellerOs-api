/*
  Warnings:

  - You are about to drop the `CreationTask` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Prompt` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `CreationTask` DROP FOREIGN KEY `CreationTask_userId_fkey`;

-- DropForeignKey
ALTER TABLE `Prompt` DROP FOREIGN KEY `Prompt_userId_fkey`;

-- DropTable
DROP TABLE `CreationTask`;

-- DropTable
DROP TABLE `Prompt`;
