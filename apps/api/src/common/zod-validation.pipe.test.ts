import { ShapePatchSchema, ShapeCreatePayloadSchema } from '@collab/shared';
import { describe, expect, it } from 'vitest';

import { AppError } from './errors';
import { ZodValidationPipe, zodPipe } from './zod-validation.pipe';
import { RegisterSchema } from '../modules/auth/auth.dto';

describe('ZodValidationPipe', () => {
  it('合法输入原样通过（并剥掉未声明字段）', () => {
    const pipe = new ZodValidationPipe(RegisterSchema);
    const result = pipe.transform({
      email: '  USER@Example.com ',
      password: 'supersecret',
      displayName: '  小明  ',
      // 未声明字段：zod 默认 strip，等价于 Nest ValidationPipe 的 whitelist
      role: 'admin',
    });
    expect(result).toEqual({
      email: 'USER@Example.com',
      password: 'supersecret',
      displayName: '小明',
    });
    expect('role' in result).toBe(false);
  });

  it('非法输入抛 AppError + VALIDATION_FAILED + 400，并带字段路径', () => {
    const pipe = new ZodValidationPipe(RegisterSchema);
    try {
      pipe.transform({ email: 'not-an-email', password: '123', displayName: '' });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('VALIDATION_FAILED');
      expect(appError.httpStatus).toBe(400);
      // detail 里保留 zod 的 issues，便于前端定位字段
      expect(Array.isArray(appError.detail)).toBe(true);
    }
  });

  it('缺少 body / 传入 null 也会被拒', () => {
    const pipe = zodPipe(RegisterSchema);
    expect(() => pipe.transform(undefined)).toThrow(AppError);
    expect(() => pipe.transform(null)).toThrow(AppError);
  });

  it('可以直接复用 shared 的协议 schema（协议即类型）', () => {
    const pipe = new ZodValidationPipe(ShapeCreatePayloadSchema);
    expect(() => pipe.transform({ boardId: 'not-a-uuid', shape: {}, clientOpId: 'x' })).toThrow(
      AppError,
    );
  });

  it('ShapePatch 的空对象 refine 生效（协议要求 patch 非空）', () => {
    expect(ShapePatchSchema.safeParse({}).success).toBe(false);
    expect(ShapePatchSchema.safeParse({ x: 1 }).success).toBe(true);
  });
});
