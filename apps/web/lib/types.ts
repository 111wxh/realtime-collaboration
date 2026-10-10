/**
 * REST 资源类型。
 *
 * 注意：协议包（@collab/shared）只定义图形与 WS 消息；用户 / 房间的 REST 形状在这里声明。
 * 房间相关的可选字段是"双形状兼容"：冻结契约把 boardId 放在响应顶层，
 * 而 apps/api 的实现把它放在 room.boardId 里（见 RoomView），前端两处都认。
 */

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
  createdAt: string;
}

export interface Room {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  createdAt: string;
  /** 第一版一房一板：boardId 由房间带出来 */
  boardId?: string;
  isPublic?: boolean;
  /** 当前用户在该房间的角色 */
  role?: string;
  memberCount?: number;
}

export interface RoomMember {
  userId: string;
  displayName?: string;
  avatarColor?: string;
  role?: string;
  joinedAt?: string;
}

/** GET /api/rooms/:id（members 为冻结契约字段；实现侧另有 /members 子路由） */
export interface RoomDetail {
  room: Room;
  boardId?: string;
  members?: RoomMember[];
}

/** POST /api/rooms 与 POST /api/rooms/join 的返回值 */
export interface RoomAccess {
  room: Room;
  boardId: string;
}
