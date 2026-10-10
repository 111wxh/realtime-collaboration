import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { unauthenticated } from '../../common/errors';
import type { AuthUser, AuthenticatedRequest } from './jwt-auth.guard';

/**
 * 取当前登录用户：`@CurrentUser() user: AuthUser` 或 `@CurrentUser('id') userId: string`。
 * 只有 JwtAuthGuard 通过后才有值，拿不到就说明守卫没挂——直接抛 UNAUTHENTICATED 而不是返回 undefined，
 * 避免业务代码带着空用户跑下去。
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, context: ExecutionContext): AuthUser | string => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) throw unauthenticated();
    return field ? user[field] : user;
  },
);
