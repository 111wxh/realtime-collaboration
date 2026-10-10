import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { alreadyExists, forbidden, notFound } from '../../common/errors';
import { generateInviteCode } from '../../common/tokens';
import { PrismaService } from '../../prisma/prisma.service';
import type { RoomMemberView, RoomView } from './room.dto';

/** 邀请码撞车时的重试次数：32^8 的空间下几乎不会发生，重试只为兜底 */
const INVITE_CODE_RETRIES = 5;

/**
 * 房间服务。第一版一房一板：建房时同事务建出 boards 行，
 * 后续 board 操作都通过房间成员关系鉴权（§7.7 授权）。
 */
@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, name: string): Promise<RoomView> {
    for (let attempt = 0; attempt < INVITE_CODE_RETRIES; attempt += 1) {
      try {
        // 房间 + owner 成员 + 画布必须在同一个事务里落库：
        // 否则可能建出一个没有画布的房间，实时网关拿不到 boardId
        const room = await this.prisma.$transaction(async (tx) => {
          const created = await tx.room.create({
            data: {
              name: name.trim(),
              ownerId: userId,
              inviteCode: generateInviteCode(),
            },
          });
          await tx.roomMember.create({ data: { roomId: created.id, userId, role: 'owner' } });
          const board = await tx.board.create({ data: { roomId: created.id, name: 'main' } });
          return { created, boardId: board.id };
        });
        this.logger.log({ roomId: room.created.id, userId }, '房间已创建');
        return {
          id: room.created.id,
          name: room.created.name,
          ownerId: room.created.ownerId,
          inviteCode: room.created.inviteCode,
          isPublic: room.created.isPublic,
          createdAt: room.created.createdAt.toISOString(),
          role: 'owner',
          boardId: room.boardId,
          memberCount: 1,
        };
      } catch (error) {
        // 只对 invite_code 唯一冲突重试；其他错误直接冒泡
        if (this.isUniqueViolation(error, 'invite_code')) continue;
        throw error;
      }
    }
    throw alreadyExists('邀请码生成冲突，请重试');
  }

  /** 我加入的房间（按成员关系过滤，天然满足授权：不在此列表里的房间看不到） */
  async listMine(userId: string): Promise<RoomView[]> {
    const memberships = await this.prisma.roomMember.findMany({
      where: { userId, room: { deletedAt: null } },
      include: {
        room: {
          include: {
            boards: { select: { id: true }, orderBy: { createdAt: 'asc' }, take: 1 },
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });
    return memberships.map((membership) => ({
      id: membership.room.id,
      name: membership.room.name,
      ownerId: membership.room.ownerId,
      inviteCode: membership.room.inviteCode,
      isPublic: membership.room.isPublic,
      createdAt: membership.room.createdAt.toISOString(),
      role: membership.role,
      boardId: membership.room.boards[0]?.id ?? '',
      memberCount: membership.room._count.members,
    }));
  }

  /**
   * 用邀请码加入。幂等：已是成员时直接返回既有成员关系，
   * 不重复插入（前端重试/双击不会产生第二条成员记录）。
   */
  async join(
    userId: string,
    inviteCode: string,
  ): Promise<{ room: RoomView; alreadyMember: boolean }> {
    const room = await this.prisma.room.findUnique({
      where: { inviteCode },
      include: { boards: { select: { id: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!room || room.deletedAt) throw notFound('邀请码无效或房间已关闭');

    const existing = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: room.id, userId } },
    });
    if (existing) {
      return { room: await this.toView(room, userId), alreadyMember: true };
    }

    try {
      await this.prisma.roomMember.create({ data: { roomId: room.id, userId, role: 'member' } });
    } catch (error) {
      // 与其并发加入的两个请求：唯一约束兜底，落败的一方按"已是成员"处理
      if (!this.isUniqueViolation(error)) throw error;
      return { room: await this.toView(room, userId), alreadyMember: true };
    }
    this.logger.log({ roomId: room.id, userId }, '成员加入房间');
    return { room: await this.toView(room, userId), alreadyMember: false };
  }

  async get(userId: string, roomId: string): Promise<RoomView> {
    await this.assertMembership(userId, roomId);
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        boards: { select: { id: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        _count: { select: { members: true } },
      },
    });
    if (!room || room.deletedAt) throw notFound('房间不存在或已关闭');
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      inviteCode: room.inviteCode,
      isPublic: room.isPublic,
      createdAt: room.createdAt.toISOString(),
      role: (await this.roleOf(roomId, userId)) ?? 'member',
      boardId: room.boards[0]?.id ?? '',
      memberCount: room._count.members,
    };
  }

  async members(userId: string, roomId: string): Promise<RoomMemberView[]> {
    await this.assertMembership(userId, roomId);
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.user.displayName,
      avatarColor: row.user.avatarColor,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    }));
  }

  /** 房间内的成员关系断言：不存在即 403（不是 404——房间存在与否不该泄露给非成员） */
  async assertMembership(userId: string, roomId: string): Promise<void> {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { userId: true },
    });
    if (!member) throw forbidden('你不是该房间成员');
  }

  /**
   * board 级鉴权：先由 board 找 room，再校验成员关系。
   * 客户端声明的 boardId/roomId 一律不信任，授权永远回到 room_members 这张表。
   */
  async assertBoardAccess(
    userId: string,
    boardId: string,
  ): Promise<{ boardId: string; roomId: string }> {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      select: { id: true, roomId: true },
    });
    if (!board) throw notFound('画布不存在');
    await this.assertMembership(userId, board.roomId);
    return { boardId: board.id, roomId: board.roomId };
  }

  /** 记录活跃时间（room_members.last_seen_at），best-effort，失败不影响主流程 */
  async touchMember(roomId: string, userId: string): Promise<void> {
    try {
      await this.prisma.roomMember.updateMany({
        where: { roomId, userId },
        data: { lastSeenAt: new Date() },
      });
    } catch {
      /* 观测性字段，失败忽略 */
    }
  }

  /** 房间的第一张画布 id（第一版一房一板）；房间不存在返回 null */
  async boardIdOfRoom(roomId: string): Promise<string | null> {
    const board = await this.prisma.board.findFirst({
      where: { roomId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return board?.id ?? null;
  }

  /** 取成员角色；非成员返回 null */
  async roleOf(roomId: string, userId: string): Promise<string | null> {
    const row = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  private async toView(
    room: {
      id: string;
      name: string;
      ownerId: string;
      inviteCode: string;
      isPublic: boolean;
      createdAt: Date;
      boards: { id: string }[];
    },
    userId: string,
  ): Promise<RoomView> {
    const [role, count] = await Promise.all([
      this.roleOf(room.id, userId),
      this.prisma.roomMember.count({ where: { roomId: room.id } }),
    ]);
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      inviteCode: room.inviteCode,
      isPublic: room.isPublic,
      createdAt: room.createdAt.toISOString(),
      role: role ?? 'member',
      boardId: room.boards[0]?.id ?? '',
      memberCount: count,
    };
  }

  private isUniqueViolation(error: unknown, field?: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    return field ? fields.some((f) => f.includes(field)) : true;
  }
}
