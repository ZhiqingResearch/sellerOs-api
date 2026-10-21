import { Module } from "@nestjs/common"
import { SkillsKeyConfigService } from "./skills-key-config.service"
import { SkillsKeyCryptoService } from "./skills-key-crypto.service"
import { SkillsKeyIssuerService } from "./skills-key-issuer.service"
import { SkillsKeysController } from "./skills-keys.controller"
import { SkillsKeysService } from "./skills-keys.service"

@Module({
  controllers: [SkillsKeysController],
  providers: [
    SkillsKeysService,
    SkillsKeyConfigService,
    SkillsKeyCryptoService,
    SkillsKeyIssuerService,
  ],
  exports: [SkillsKeysService],
})
export class SkillsKeysModule {}
