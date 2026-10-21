# 敏感词库（hard rule，跨模式优先）

## 优先级声明

**Listing 编写规则与敏感词库矛盾时，敏感词库优先。** 敏感词库优先于本 skill 任何示例、模板、范式说明。生成前后都必须扫描成品文本；命中则立即重写，绝不输出。

## 适用于所有链接的敏感词库（standard + custom 都禁用）

| 词 | 处置 |
|----|------|
| `Microsoft` | 禁用（即使是描述 Windows 系统也改用 "Windows 11" 而非 "Microsoft Windows"） |
| `inspiron` | 禁用 |
| `™` | 禁用所有商标符号 |
| `®` | 禁用所有注册商标符号 |
| `intel core`（连写） | **绝对禁止** "intel" 与 "core" 相邻出现（不区分大小写，中间无论隔几个空格都算连写）。必须在 "intel" 和 "core" 之间插入型号/代数标识，或者直接省略 "core"。✅ 合规示例：`Intel Ultra 7 Core 255U`、`Intel Ultra 7 255U Processor`、`Intel i5 14400F`、`Intel 10th Gen Core i7`。❌ 违规示例：`Intel Core Ultra 7`、`Intel Core i5`、`intel core processor`（均命中 "intel core" 子串）。**注意 Ultra 系列**：Intel 新命名如 "Intel Core Ultra 7 255U" 仍然包含 "intel core" 子串，必须改写为 "Intel Ultra 7 Core 255U" 或 "Intel Ultra 7 255U Processor" |

## 仅适用于定制化（custom 模式）的敏感词库

| 词 | 处置 |
|----|------|
| `Samsung` | 禁用 |
| `NVIDIA` | 禁用（GPU 描述改用通用表述如 "discrete graphics"、"dedicated GPU"） |
| `Lenovo` | 禁用（即使作为 OEM 原机品牌，也不可写在 listing 任何位置） |

## 检测与重写流程

1. **生成时**：对 title / 每条 bullet / description / searchTerms 全字段做不区分大小写的子串扫描。
2. **命中处理**：
   - 若是 OEM 型号引用（如 `oemModel="Lenovo ThinkPad E16"`），将品牌部分替换为通用占位（如 "a 16-inch business laptop"），保留型号识别度但不出现品牌名。
   - 若是规格描述（如 `intel core i5`），改写为 `Intel i5 Processor` 或 `Intel 13th Gen i5`（在 "intel" 和 "core" 之间必须插入型号标识，或直接省略 "core"）。Ultra 系列：`Intel Core Ultra 7 255U` → `Intel Ultra 7 Core 255U` 或 `Intel Ultra 7 255U Processor`。
   - 若是 Microsoft Windows，改写为 `Windows 11 Home` 等。
3. **生成后兜底**：JSON 输出前再做一次全字段扫描；仍命中 → 整体重新生成该字段。

## Hard fail 规则

如果用户输入的 `oemModel`、`extra` 等字段已经包含 custom 模式禁用品牌（如 `oemModel="Lenovo ThinkPad"`），生成的 listing **任何字段都不得复读**该品牌名。可用替代：

- "an enterprise-grade 16-inch laptop platform"
- "a popular 17-inch FHD platform"
- "a leading business laptop chassis"

宁可信息颗粒度下降，也绝不命中敏感词。
