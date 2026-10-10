import { z } from 'zod';

/** 房间相关的 REST DTO（与认证模块同理：REST 表单约束留在 api 内） */

export const CreateRoomSchema = z.object({
  name: z.string().trim().min(1, '房间名不能为空').max(64, '房间名最长 64 字符'),
});
export type CreateRoomDto = z.output<typeof CreateRoomSchema>;

export const JoinRoomSchema = z.object({
  inviteCode: z
    .string()
    .trim()
    .min(4, '邀请码长度不正确')
    .max(16, '邀请码长度不正确')
    .transform((value) => value.toUpperCase()),
});
export type JoinRoomDto = z.output<typeof JoinRoomSchema>;

/** 房间视图：列表与详情共用一个形状 */
export interface RoomView {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  isPublic: boolean;
  createdAt: string;
  /** 当前用户在该房间的角色：owner | member */
  role: string;
  /** 第一版一房一板；后续多画布时换数组 */
  boardId: string;
  memberCount: number;
}

export interface RoomMemberView {
  userId: string;
  displayName: string;
  avatarColor: string;
  role: string;
  joinedAt: string;
}
