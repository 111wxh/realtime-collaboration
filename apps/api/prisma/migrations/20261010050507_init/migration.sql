-- citext 扩展：users.email 用大小写不敏感类型（计划书 §5.2）。
-- Prisma schema 只能声明 @db.Citext，扩展的创建必须由迁移显式完成。
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "avatar_color" TEXT NOT NULL DEFAULT '#4C8DFF',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "invite_code" TEXT NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "boards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'main',
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shapes" (
    "id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "z_index" INTEGER NOT NULL DEFAULT 0,
    "style" JSONB NOT NULL DEFAULT '{}',
    "data" JSONB NOT NULL DEFAULT '{}',
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "shapes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shape_ops" (
    "id" BIGSERIAL NOT NULL,
    "board_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "actor_id" UUID,
    "op_type" TEXT NOT NULL,
    "shape_id" UUID,
    "payload" JSONB NOT NULL,
    "client_op_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shape_ops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_snapshots" (
    "board_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_snapshots_pkey" PRIMARY KEY ("board_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_invite_code_key" ON "rooms"("invite_code");

-- CreateIndex
CREATE INDEX "boards_room_id_idx" ON "boards"("room_id");

-- CreateIndex
CREATE INDEX "shapes_board_id_idx" ON "shapes"("board_id");

-- 部分索引（计划书 §5.2 / §7.4）：只索引活图形，排除软删行。
-- Prisma schema 表达不了带 WHERE 的部分索引，只能手工维护在这里。
-- 注意：后续用 `prisma migrate dev` 生成新迁移时必须加 --create-only 并人工核对，
-- 否则 Prisma 会认为它是"schema 里没有的多余索引"而生成 DROP。
CREATE INDEX "idx_shapes_board_alive" ON "shapes"("board_id") WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "shape_ops_board_id_seq_idx" ON "shape_ops"("board_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "shape_ops_board_id_seq_key" ON "shape_ops"("board_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "shape_ops_board_id_client_op_id_key" ON "shape_ops"("board_id", "client_op_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boards" ADD CONSTRAINT "boards_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shapes" ADD CONSTRAINT "shapes_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shapes" ADD CONSTRAINT "shapes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shape_ops" ADD CONSTRAINT "shape_ops_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shape_ops" ADD CONSTRAINT "shape_ops_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
