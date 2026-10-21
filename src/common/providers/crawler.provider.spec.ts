import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { CrawlerProvider } from "./crawler.provider"

jest.mock("axios")
const http = jest.mocked(axios)

describe("审计爬虫 HTTP 状态", () => {
  it.each([401, 403, 429, 503])("HTTP %s 即使带成功信封也失败，供 Apify 兜底", async status => {
    http.post.mockResolvedValue({ status, data: { code: 200, data: { title: "不应接受" } } })
    const crawler = new CrawlerProvider(new ConfigService())
    await expect(crawler.fetchAudit("https://www.amazon.com/dp/B012345678")).rejects.toMatchObject({
      code: `UPSTREAM_HTTP_${status}`,
    })
  })
})
