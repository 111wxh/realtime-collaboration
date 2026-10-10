import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { unauthenticated } from '../../common/errors';
import { extractBearerToken } from '../../common/tokens';

/** 通过鉴权后挂在请求 / socket 上的用户身份 */
export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

/**
 * 从 `Authorization: Bearer <access token>` 恢复身份。
 * 无 token / token 失效都抛 UNAUTHENTICATED（协议错误码，前端据此跳登录页）。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = extractBearerToken(typeof header === 'string' ? header : undefined);
    if (!token) throw unauthenticated('缺少访问令牌');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(token);
      request.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw unauthenticated('访问令牌无效或已过期');
    }
  }
}
