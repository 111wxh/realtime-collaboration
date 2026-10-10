import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';

import { APP_CONFIG, type AppConfig } from '../../common/config';
import { alreadyExists, unauthenticated } from '../../common/errors';
import { generateRefreshToken, hashRefreshToken } from '../../common/tokens';
import { PrismaService } from '../../prisma/prisma.service';
import type { LoginDto, RegisterDto, UserView } from './auth.dto';

export interface IssuedTokens {
  accessToken: string;
  /** 只在这个结构里出现一次，随后立即写进 httpOnly cookie，不再回传 body */
  refreshToken: string;
}

export interface AuthResult extends IssuedTokens {
  user: UserView;
}

/** 访问令牌 payload */
export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export function toUserView(user: User): UserView {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * 认证服务：注册 / 登录 / 刷新 / 登出。
 *
 * 安全取舍（计划书 §7.7）：
 *  - 密码只存 argon2id 哈希；
 *  - access token 短时（JWT_EXPIRES_IN，默认 15m），refresh token 是不透明随机串、
 *    存哈希、可撤销，落在 httpOnly cookie 里（JS 读不到，防 XSS 窃取）；
 *  - 刷新即轮换（旧的立刻撤销），旧令牌重放直接判无效；
 *  - 邮箱冲突靠 citext 唯一约束兜底，捕获 P2002 转 409/ALREADY_EXISTS。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    // citext 已经做了大小写不敏感唯一，这里再统一小写，保证查询计划稳定
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: dto.displayName.trim() },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw alreadyExists('该邮箱已注册');
      }
      throw error;
    }
    this.logger.log({ userId: user.id }, '新用户注册');
    return { user: toUserView(user), ...(await this.issueTokens(user)) };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // 用户不存在与密码错误返回同一个错误，避免账号枚举
    if (!user) throw unauthenticated('邮箱或密码不正确');
    const ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) throw unauthenticated('邮箱或密码不正确');
    return { user: toUserView(user), ...(await this.issueTokens(user)) };
  }

  /** 刷新即轮换：撤销旧令牌 → 签发新的一对 */
  async refresh(rawToken: string | undefined): Promise<AuthResult> {
    if (!rawToken) throw unauthenticated('缺少刷新令牌');
    const tokenHash = hashRefreshToken(rawToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
      throw unauthenticated('刷新令牌无效或已过期');
    }
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });
    return { user: toUserView(record.user), ...(await this.issueTokens(record.user)) };
  }

  /** 登出：撤销刷新令牌（幂等——重复登出不算错） */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthenticated('用户不存在或已注销');
    return toUserView(user);
  }

  private async issueTokens(user: Pick<User, 'id' | 'email'>): Promise<IssuedTokens> {
    const payload: AccessTokenPayload = { sub: user.id, email: user.email };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + this.config.refreshTokenTtlMs),
      },
    });
    return { accessToken, refreshToken };
  }
}
