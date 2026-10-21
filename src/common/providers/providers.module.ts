import { Global, Module } from "@nestjs/common"
import { AiGatewayProvider } from "./ai-gateway.provider"
import { AllinpayProvider } from "./allinpay.provider"
import { ApifyProvider } from "./apify.provider"
import { AtlasProvider } from "./atlas.provider"
import { BaiduXilingProvider } from "./baidu-xiling.provider"
import { CrawlerProvider } from "./crawler.provider"
import { FeishuProvider } from "./feishu.provider"
import { GoogleProvider } from "./google.provider"
import { MailProvider } from "./mail.provider"
import { StripeProvider } from "./stripe.provider"
import { SuchuangProvider } from "./suchuang.provider"
import { TokenlabProvider } from "./tokenlab.provider"
import { YingdaoProvider } from "./yingdao.provider"
import { ZixiaoyunProvider } from "./zixiaoyun.provider"

const providers = [
  AllinpayProvider,
  AiGatewayProvider,
  GoogleProvider,
  BaiduXilingProvider,
  CrawlerProvider,
  AtlasProvider,
  TokenlabProvider,
  SuchuangProvider,
  MailProvider,
  StripeProvider,
  ApifyProvider,
  YingdaoProvider,
  ZixiaoyunProvider,
  FeishuProvider,
]

@Global()
@Module({
  providers,
  exports: providers,
})
export class ProvidersModule {}
