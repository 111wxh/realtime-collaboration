import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RoomController } from './room.controller';
import { RoomService } from './room.service';

/**
 * 房间模块。导入 AuthModule 是因为 `@UseGuards(JwtAuthGuard)` 会在本模块的
 * 注入上下文里解析守卫依赖（JwtService 由 AuthModule 导出）。
 */
@Module({
  imports: [AuthModule],
  controllers: [RoomController],
  providers: [RoomService],
  exports: [RoomService],
})
export class RoomModule {}
