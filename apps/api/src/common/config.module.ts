import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, loadConfig } from './config';

/**
 * 全局配置模块。
 *
 * 为什么必须是 @Global：APP_CONFIG 被 RedisModule、PresenceModule、AuthModule、
 * BoardModule 等**被导入的模块**里的 provider 注入，而 Nest 的模块作用域不允许
 * 子模块看到父模块的 provider——配置要么放进全局模块，要么每个模块重复 import。
 * 顺带的好处是 loadConfig 只在启动时执行一次。
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
