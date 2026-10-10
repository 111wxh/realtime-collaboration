import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { zodPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CreateRoomSchema,
  JoinRoomSchema,
  type CreateRoomDto,
  type JoinRoomDto,
  type RoomMemberView,
  type RoomView,
} from './room.dto';
import { RoomService } from './room.service';

/**
 * 房间接口（全部需要登录）：
 *   POST /api/rooms         创建（creator=owner，同事务建 boards）
 *   GET  /api/rooms         我加入的房间
 *   POST /api/rooms/join    邀请码加入（幂等）
 *   GET  /api/rooms/:id     房间详情（非成员 403）
 *   GET  /api/rooms/:id/members  成员列表（非成员 403）
 *
 * 注意路由顺序：`join` 必须在 `:id` 之前声明，否则会被当成 roomId。
 */
@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomController {
  constructor(private readonly roomService: RoomService) {}

  @Post()
  async create(
    @CurrentUser('id') userId: string,
    @Body(zodPipe(CreateRoomSchema)) dto: CreateRoomDto,
  ): Promise<{ room: RoomView }> {
    return { room: await this.roomService.create(userId, dto.name) };
  }

  @Get()
  async listMine(@CurrentUser('id') userId: string): Promise<{ rooms: RoomView[] }> {
    return { rooms: await this.roomService.listMine(userId) };
  }

  @Post('join')
  async join(
    @CurrentUser('id') userId: string,
    @Body(zodPipe(JoinRoomSchema)) dto: JoinRoomDto,
  ): Promise<{ room: RoomView; alreadyMember: boolean }> {
    return this.roomService.join(userId, dto.inviteCode);
  }

  @Get(':id')
  async get(
    @CurrentUser('id') userId: string,
    @Param('id') roomId: string,
  ): Promise<{ room: RoomView }> {
    return { room: await this.roomService.get(userId, roomId) };
  }

  @Get(':id/members')
  async members(
    @CurrentUser('id') userId: string,
    @Param('id') roomId: string,
  ): Promise<{ members: RoomMemberView[] }> {
    return { members: await this.roomService.members(userId, roomId) };
  }
}
