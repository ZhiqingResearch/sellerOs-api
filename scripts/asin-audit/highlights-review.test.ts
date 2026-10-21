import assert from "node:assert/strict"
import {
  compareConfigurations,
  mergeHighlightsListing,
  parseCorrectConfigurations,
} from "./highlights-review"
import { hashValue } from "./listing-audit"

const correct = parseCorrectConfigurations("错误配置：未识别内存；正确配置：32GB RAM + 2TB 存储")
assert.deepEqual(correct, [{ ramGb: 32, storageGb: 2048 }])
assert.throws(() => parseCorrectConfigurations("正确配置：未知"))
const sample = compareConfigurations(
  "ASUS ROG Strix G18 Gaming Laptop, 18 inch 2.5K",
  "Intel Ultra 9 275HX, GeForce RTX 5070 8GB GDDR7, 32 GB DDR5, 2 TB SSD, Thunderbolt 4",
  correct
)
assert.equal(sample.status, "匹配")
assert.equal(
  sample.evidence.some(item => item.kind === "ram" && item.capacityGb === 8),
  false
)
assert.equal(compareConfigurations("32GB RAM", "2TB SSD", correct).status, "匹配")
assert.equal(compareConfigurations("16GB RAM", "2TB SSD", correct).status, "不匹配")
assert.equal(compareConfigurations("32GB RAM", "1TB SSD", correct).status, "不匹配")
assert.equal(
  compareConfigurations("32GB RAM 2TB SSD", "16GB RAM 2TB SSD", correct).status,
  "不匹配"
)
assert.equal(compareConfigurations("Laptop", "", correct).status, "无法判断")
assert.equal(compareConfigurations("32GB RAM", "", correct).status, "无法判断")
assert.equal(compareConfigurations("16GB RAM", "", correct).status, "不匹配")
assert.equal(compareConfigurations("32GB RAM", "Up to 2TB SSD", correct).status, "无法判断")
assert.equal(compareConfigurations("32GB RAM", "2TB Cloud Storage", correct).status, "无法判断")
const alternatives = parseCorrectConfigurations(
  "正确配置：16GB RAM + 1TB 存储 / 32GB RAM + 2TB 存储"
)
assert.equal(compareConfigurations("32GB RAM 2TB SSD", "", alternatives).status, "匹配")
assert.equal(compareConfigurations("32GB RAM 1TB SSD", "", alternatives).status, "不匹配")
assert.equal(
  compareConfigurations("Memory: 32 GB", "Hard Disk Size: 2048 GB", correct).status,
  "匹配"
)
const original = {
  listing: { title: "old", bullets: ["bullet"], description: "body" },
  raw: { title: "old", sold_out: true },
  currentListing: { title: "old", images: ["image"], isSoldOut: true },
}
const originalHash = hashValue(original)
const highlights = {
  fetchedAt: "2026-09-14T00:00:00Z",
  response: { data: { title: "new", second_title: "32GB RAM 2TB SSD" } },
}
const merged = mergeHighlightsListing(original, highlights)
assert.equal(hashValue(original), originalHash)
assert.equal(hashValue(merged.originalAuditSnapshot), originalHash)
assert.equal(merged.listing.title, "new")
assert.equal(merged.currentListing.title, "new")
assert.equal(merged.currentListing.second_title, "32GB RAM 2TB SSD")
assert.deepEqual(merged.listing.bullets, original.listing.bullets)
assert.deepEqual(merged.raw, original.raw)
assert.equal(merged.currentListing.isSoldOut, true)
assert.equal(
  hashValue(mergeHighlightsListing(merged, highlights).originalAuditSnapshot),
  originalHash
)
const memoryStorageCases: Array<[string, string, number, number, string]> = [
  ["Gaming", "RTX 5070 8GB GDDR7, 32G DDR5 RAM, 2TB SSD", 32, 2048, "匹配"],
  ["Intel up to 5GHz, 32GB RAM, 2TB SSD", "", 32, 2048, "匹配"],
  ["16GB RAM", "128GB UFS+256GB MSD", 16, 128, "匹配"],
  ["16GB RAM", "128GB UFS & 256GB SD Card", 16, 128, "匹配"],
  ["32GB RAM", "1TB Gen 5 NVMe SSD", 32, 1024, "匹配"],
  ["16GB RAM", "2TB PCIe Gen4 SSD", 16, 2048, "匹配"],
  ["16 GB 7500 DDR5X RAM, 4 TB PCIe SSD", "", 16, 4096, "匹配"],
  ["32 GB 7500 MHz, 2 TB SSD", "", 32, 2048, "匹配"],
  ["64 GB 5600MHz DDR5, 4 TB SSD", "", 64, 4096, "匹配"],
  ["64 GB 5600 MT/s DDR5 RAM, 4 TB PCIe NVMe SSD", "", 64, 4096, "匹配"],
  ["16 GB 8500 MHz LPDDR5X RAM, 2 TB SSD", "", 16, 2048, "匹配"],
  ["16GB DDR5 RAM 1TB", "", 16, 1024, "匹配"],
  ["16GB DDR5 RAM 512GB", "", 16, 512, "匹配"],
  ["32GB DDR5 4400 MT/s 1TB Intel Core", "", 32, 1024, "匹配"],
  ["64GB DDR5-5600MT/s, 2TB", "", 64, 2048, "匹配"],
  ["32GB LPDDR5X RAM, 1TB, Lightweight Laptop", "", 32, 2048, "不匹配"],
  ["16GB DDR5 RAM 2TB SSD", "", 16, 2048, "匹配"],
  ["32GB RAM, 1TB Cloud Storage", "", 32, 1024, "无法判断"],
  ["32GB RAM, 1TB External SSD", "", 32, 1024, "无法判断"],
  ["32GB RAM, 8GB GDDR7, 1TB SSD", "", 32, 1024, "匹配"],
  ["32GB RAM, 1TB RAM", "", 32, 1024, "不匹配"],
  ["RTX 5060 8GB GDDR7 Graphics", "2TB SSD, 5G Networking", 32, 2048, "无法判断"],
]
for (const [title, secondTitle, ramGb, storageGb, expectedStatus] of memoryStorageCases) {
  assert.equal(
    compareConfigurations(title, secondTitle, [{ ramGb, storageGb }]).status,
    expectedStatus,
    title + " | " + secondTitle
  )
}
console.log("原始配置/证据保留断言与22组真实格式、误读排除回归通过")
