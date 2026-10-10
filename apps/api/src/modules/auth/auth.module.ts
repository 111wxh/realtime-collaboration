import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { APP_CONFIG, type AppConfig } from '../../common/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * 认证模块。JwtModule 的密钥与有效期来自环境变量（§11.2）。
 * 这里只注册守卫的依赖；守卫本身按需 @UseGuards(JwtAuthGuard) 使用。
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtExpiresIn },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
