import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RoomModule } from '../room/room.module';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';
import { BOARD_TX_RUNNER } from './board.types';
import { PrismaBoardTxRunner } from './prisma-board.tx';

/**
 * 画布模块。BOARD_TX_RUNNER 用抽象令牌注入：
 * 生产实现是 PrismaBoardTxRunner（Postgres 事务 + 行锁），
 * 单测可以换成 InMemoryBoardTxRunner 跑同一份引擎逻辑。
 * AuthModule 是为了给 @UseGuards(JwtAuthGuard) 提供 JwtService。
 */
@Module({
  imports: [AuthModule, RoomModule],
  controllers: [BoardController],
  providers: [BoardService, { provide: BOARD_TX_RUNNER, useClass: PrismaBoardTxRunner }],
  exports: [BoardService, BOARD_TX_RUNNER],
})
export class BoardModule {}
