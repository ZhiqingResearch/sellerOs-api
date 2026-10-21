-- Script 补充视频合成失败原因字段

ALTER TABLE `Script`
  ADD COLUMN `videoErrorMessage` TEXT NULL;
