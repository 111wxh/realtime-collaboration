import { z } from 'zod';

/**
 * 认证相关的 REST DTO。
 *
 * 放在 api 内部而不是 @collab/shared：shared 里的 schema 是**协议契约**
 * （WS 消息 + 前后端共用的边界），注册/登录的表单约束属于后端对外的 REST 接口，
 * 前端是否复用由前端自己决定，不该反向污染协议包。
 */

export const RegisterSchema = z.object({
  email: z.string().trim().min(3).max(254).email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位').max(128, '密码最长 128 位'),
  displayName: z.string().trim().min(1, '昵称不能为空').max(64, '昵称最长 64 字符'),
});
export type RegisterDto = z.output<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().min(3).max(254).email('邮箱格式不正确'),
  password: z.string().min(1, '密码不能为空').max(128),
});
export type LoginDto = z.output<typeof LoginSchema>;

/** 对外暴露的用户视图（绝不包含 password_hash） */
export interface UserView {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
  createdAt: string;
}
