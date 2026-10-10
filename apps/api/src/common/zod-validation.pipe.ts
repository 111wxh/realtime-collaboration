import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

import { validationFailed } from './errors';

/**
 * Zod 校验管道：REST DTO 直接用 @collab/shared 里的 schema（协议即类型，
 * 前后端同一套约束），REST 专有的 body（如注册参数）在各自模块内定义。
 *
 * zod 默认会剥掉未声明的字段（strip），这正好实现了 ValidationPipe 的 whitelist 效果。
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<
  unknown,
  z.output<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path.join('.') ?? '';
      const message = first ? `${path ? `${path}: ` : ''}${first.message}` : '请求体校验失败';
      throw validationFailed(message, result.error.issues);
    }
    return result.data;
  }
}

/** 语法糖：`@Body(zodPipe(RegisterSchema)) dto: RegisterDto` */
export function zodPipe<T extends ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
