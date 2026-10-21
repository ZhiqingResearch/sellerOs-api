/**
 * 导出指定用户的用量日志到 Excel
 * 用法：npx ts-node scripts/export-usage-log.ts [userId]
 * 默认导出 userId=36 的数据
 */

import { PrismaClient } from "@prisma/client"
import * as path from "path"
import * as XLSX from "xlsx"
// 来源中文映射单一事实来源（与积分明细「项目」列共用），新增来源只改 src/usage/usage-source-labels.ts
import { SOURCE_LABEL_MAP } from "../src/usage/usage-source-labels"

const TYPE_LABEL_MAP: Record<string, string> = {
  TOKEN: "Token 计费",
  MCP: "MCP 调用",
}

async function main() {
  const userId = parseInt(process.argv[2] ?? "36", 10)
  if (isNaN(userId)) {
    console.error("用法：npx ts-node scripts/export-usage-log.ts [userId]")
    process.exit(1)
  }

  const prisma = new PrismaClient()

  try {
    console.log(`正在查询 userId=${userId} 的用量日志...`)

    const logs = await prisma.usageLog.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        type: true,
        promptTokens: true,
        completionTokens: true,
        thinkingTokens: true,
        mcpCalls: true,
        inputCost: true,
        outputCost: true,
        cost: true,
        balanceAfter: true,
        source: true,
        createdAt: true,
      },
    })

    if (logs.length === 0) {
      console.log(`userId=${userId} 暂无用量记录`)
      return
    }

    console.log(`共查询到 ${logs.length} 条记录，正在生成 Excel...`)

    const rows = logs.map(log => ({
      ID: log.id,
      用户ID: log.userId,
      计费类型: TYPE_LABEL_MAP[log.type] ?? log.type,
      来源: log.source ? (SOURCE_LABEL_MAP[log.source] ?? log.source) : "",
      输入Token: log.promptTokens ?? "",
      输出Token: log.completionTokens ?? "",
      思考Token: log.thinkingTokens ?? "",
      MCP调用次数: log.mcpCalls ?? "",
      输入费用: log.inputCost !== null ? Number(log.inputCost) : "",
      输出费用: log.outputCost !== null ? Number(log.outputCost) : "",
      本次费用: Number(log.cost),
      余额: Number(log.balanceAfter),
      创建时间: log.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows)

    // 设置列宽
    ws["!cols"] = [
      { wch: 8 },  // ID
      { wch: 8 },  // 用户ID
      { wch: 12 }, // 计费类型
      { wch: 16 }, // 来源
      { wch: 12 }, // 输入Token
      { wch: 12 }, // 输出Token
      { wch: 12 }, // 思考Token
      { wch: 14 }, // MCP调用次数
      { wch: 12 }, // 输入费用
      { wch: 12 }, // 输出费用
      { wch: 12 }, // 本次费用
      { wch: 14 }, // 余额
      { wch: 22 }, // 创建时间
    ]

    XLSX.utils.book_append_sheet(wb, ws, "用量日志")

    const filename = `usage-log-user${userId}-${new Date().toISOString().slice(0, 10)}.xlsx`
    const outputPath = path.join(process.cwd(), filename)
    XLSX.writeFile(wb, outputPath)

    console.log(`✓ 已导出 ${logs.length} 条记录到：${outputPath}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
