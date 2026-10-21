-- Customer.industry：String → Json（多选）
-- 历史数据形如 "美容护肤" 或 "测试行业1、测试行业2" / "a,b"，按 `、` 与 `,` 拆成 JSON 数组。
-- 顺序：先转义 JSON 元字符（\ " \n \r \t）；再替换英文逗号 ` , ` → `","`；最后替换 `、` → `","`。
-- 注意：必须先替换 `,` 再替换 `、`，因为 `、` 替换后会产生包含 `,` 的 `","`，
-- 如果先替换 `、` 再替换 `,`，外层会把刚插入的逗号再次替换、破坏 JSON。

-- 1. 新增临时 JSON 列
ALTER TABLE `Customer` ADD COLUMN `industry_new` JSON NULL;

-- 2. 空值/NULL → 空数组
UPDATE `Customer`
SET `industry_new` = CAST('[]' AS JSON)
WHERE `industry` IS NULL OR `industry` = '';

-- 3. 非空：先转义 JSON 元字符，再按 `,` / `、` 切分为 JSON 数组
UPDATE `Customer`
SET `industry_new` = CAST(
  CONCAT(
    '["',
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(`industry`, '\\', '\\\\'),
                '"', '\\"'
              ),
              CHAR(10), '\\n'
            ),
            CHAR(13), '\\r'
          ),
          CHAR(9), '\\t'
        ),
        ',', '","'
      ),
      '、', '","'
    ),
    '"]'
  ) AS JSON
)
WHERE `industry` IS NOT NULL AND `industry` <> '';

-- 4. 删除旧列，重命名新列为 industry，并设为 NOT NULL（与 Prisma `Json` 必填语义对齐）
ALTER TABLE `Customer` DROP COLUMN `industry`;
ALTER TABLE `Customer` CHANGE COLUMN `industry_new` `industry` JSON NOT NULL;
