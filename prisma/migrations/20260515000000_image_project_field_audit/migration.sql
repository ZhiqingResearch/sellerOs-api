-- ProductProfile：补齐 目标国家 / 电商平台 / 商业数据 三个字段
ALTER TABLE `ProductProfile`
  ADD COLUMN `targetCountries` JSON NULL,
  ADD COLUMN `ecommercePlatforms` JSON NULL,
  ADD COLUMN `commerce` JSON NULL;

-- BrandIdentity：主色调 / 设计风格 / 图案元素 由单值 String 改为数组 Json
-- 模块刚上线，相关数据视为可丢弃，直接 DROP + ADD（避免 VARCHAR→JSON 的就地转换）
ALTER TABLE `BrandIdentity`
  DROP COLUMN `primaryColorHex`,
  DROP COLUMN `designStyle`,
  DROP COLUMN `pattern`,
  ADD COLUMN `primaryColors` JSON NULL,
  ADD COLUMN `designStyles` JSON NULL,
  ADD COLUMN `patterns` JSON NULL;
