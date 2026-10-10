import { Module } from '@nestjs/common';

import { RateLimitService } from '../common/rate-limit.service';
import { AuthModule } from '../modules/auth/auth.module';
import { BoardModule } from '../modules/board/board.module';
import { PresenceModule } from '../modules/presence/presence.module';
import { RoomModule } from '../modules/room/room.module';
import { RealtimeGateway } from './realtime.gateway';

/**
 * 实时通道模块：网关 + 限流。
 * 依赖的 AuthModule 提供 JwtService（握手鉴权与 REST 共用同一把密钥/有效期）。
 */
@Module({
  imports: [AuthModule, RoomModule, BoardModule, PresenceModule],
  providers: [RealtimeGateway, RateLimitService],
})
export class RealtimeModule {}
