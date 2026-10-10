import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/** 全局模块：Prisma 是各业务模块的公共依赖，不需要逐层 import */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
