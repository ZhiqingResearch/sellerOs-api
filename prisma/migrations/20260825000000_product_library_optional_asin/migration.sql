-- ASIN 审计可能无法解析出合法 ASIN；此时商品仍允许进入商品库。
-- MySQL 唯一索引允许多行 NULL，因此仅在 ASIN 有值时继续按 userId + marketplace + asin 去重。
ALTER TABLE `ProductLibraryItem`
    MODIFY `asin` VARCHAR(32) NULL COMMENT 'Amazon ASIN，可选；传入时统一转大写';
