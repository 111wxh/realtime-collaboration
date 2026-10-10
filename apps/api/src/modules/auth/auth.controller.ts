import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';

import { APP_CONFIG, type AppConfig } from '../../common/config';
import { Inject } from '@nestjs/common';
import { zodPipe } from '../../common/zod-validation.pipe';
import { AuthService, type AuthResult } from './auth.service';
import { LoginSchema, RegisterSchema, type LoginDto, type RegisterDto } from './auth.dto';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard, type AuthUser } from './jwt-auth.guard';

/**
 * 刷新令牌的 cookie 约定：
 *  - httpOnly + sameSite=lax：JS 读不到，普通跨站请求也带不上；
 *  - path 限定在 /api/auth：业务接口不会捎带它，泄露面最小；
 *  - Secure 由 COOKIE_SECURE 显式决定，未配置时跟随请求协议：
 *    HTTPS（含反代下的 X-Forwarded-Proto，main.ts 已开 trust proxy）才带 Secure。
 *    不能简单地写成 `NODE_ENV === 'production'`——全栈 compose 交付跑在
 *    http://localhost 上，那样配置下浏览器会直接丢掉这个 cookie，刷新/登出全废。
 */
export const REFRESH_COOKIE_NAME = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/api/auth';

export function refreshCookieOptions(config: AppConfig, secureRequest: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure ?? secureRequest,
    path: REFRESH_COOKIE_PATH,
    maxAge: config.refreshTokenTtlMs,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 注册成功即登录：返回 access token 并下发刷新 cookie，前端少一步跳转 */
  @Post('register')
  async register(
    @Req() req: Request,
    @Body(zodPipe(RegisterSchema)) dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResult['user']; accessToken: string }> {
    const result = await this.authService.register(dto);
    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      refreshCookieOptions(this.config, req.secure),
    );
    return { user: result.user, accessToken: result.accessToken };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Body(zodPipe(LoginSchema)) dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResult['user']; accessToken: string }> {
    const result = await this.authService.login(dto);
    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      refreshCookieOptions(this.config, req.secure),
    );
    return { user: result.user, accessToken: result.accessToken };
  }

  /** 用 cookie 里的刷新令牌换新的 access token（并轮换刷新令牌） */
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResult['user']; accessToken: string }> {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    const result = await this.authService.refresh(raw);
    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      refreshCookieOptions(this.config, req.secure),
    );
    return { user: result.user, accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    await this.authService.logout(raw);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser('id') userId: string): Promise<{ user: AuthResult['user'] }> {
    return { user: await this.authService.me(userId) };
  }
}

export type { AuthUser };
