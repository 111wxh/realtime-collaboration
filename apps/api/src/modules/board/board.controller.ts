import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BoardService, type BoardStateView } from './board.service';

/**
 * 画布 REST：只做"取全量状态"这一件读操作——
 * 写操作全部走 WebSocket（ack 语义 + 广播），REST 不承担实时写路径。
 */
@Controller('boards')
@UseGuards(JwtAuthGuard)
export class BoardController {
  constructor(private readonly boardService: BoardService) {}

  /** 全量状态：非房间成员 403（授权在 service 内统一做） */
  @Get(':boardId/state')
  async state(
    @CurrentUser('id') userId: string,
    @Param('boardId') boardId: string,
  ): Promise<BoardStateView> {
    return this.boardService.getState(userId, boardId);
  }
}
