import { describe, expect, it } from 'vitest';

import { BoardWriteEngine, type WriteOutcome } from './board.engine';
import { toWireOp, toWireShape } from './board.mapper';
import { BOARD_ID, USER_A, USER_B, makeOp, makeShape, setupHarness, uid } from './board.fixtures';
/** 断言辅助：把 union 收窄成 applied，失败时打印实际结果方便排查 */
function expectApplied(outcome: WriteOutcome): Extract<WriteOutcome, { status: 'applied' }> {
  if (outcome.status !== 'applied') {
    throw new Error(`期望 applied，实际 ${outcome.status}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe('BoardWriteEngine · seq 分配（§5.4 / §7.1）', () => {
  it('同一 board 的 seq 从 1 单调递增，每次 +1', async () => {
    const { runner, engine } = setupHarness();
    const seqs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const outcome = await runner.run((tx) =>
        engine.createShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          shape: makeShape({ id: uid(100 + i) }),
          clientOpId: uid(200 + i),
        }),
      );
      seqs.push(expectApplied(outcome).seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    const state = await runner.run((tx) => tx.findBoard(BOARD_ID));
    expect(state?.lastSeq).toBe(5);
    // 每个 seq 在 op log 里各占一行，不多不少
    expect(
      runner
        .inspect()
        .ops.map((op) => op.seq)
        .sort((a, b) => a - b),
    ).toEqual(seqs);
  });

  it('不同 board 的 seq 相互独立', async () => {
    const { runner, engine } = setupHarness();
    const otherBoard = uid(50);
    runner.seedBoard(otherBoard, uid(2));

    const a1 = expectApplied(
      await runner.run((tx) =>
        engine.createShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          shape: makeShape({ id: uid(101) }),
          clientOpId: uid(201),
        }),
      ),
    );
    const b1 = expectApplied(
      await runner.run((tx) =>
        engine.createShape(tx, {
          boardId: otherBoard,
          actorId: USER_A,
          shape: makeShape({ id: uid(102), boardId: otherBoard }),
          clientOpId: uid(202),
        }),
      ),
    );
    expect([a1.seq, b1.seq]).toEqual([1, 1]);
  });

  it('未 await 的并发创建也按事务串行分配，seq 不重复不丢号', async () => {
    const { runner, engine } = setupHarness();
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
        runner.run((tx) =>
          engine.createShape(tx, {
            boardId: BOARD_ID,
            actorId: USER_A,
            shape: makeShape({ id: uid(300 + i) }),
            clientOpId: uid(400 + i),
          }),
        ),
      ),
    );
    const seqs = results.map((r) => expectApplied(r).seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('board 不存在时拒绝写入，不产生任何 op', async () => {
    const { runner, engine } = setupHarness();
    const outcome = await runner.run((tx) =>
      engine.createShape(tx, {
        boardId: uid(999),
        actorId: USER_A,
        shape: makeShape({ id: uid(101) }),
        clientOpId: uid(201),
      }),
    );
    expect(outcome.status).toBe('rejected');
    expect(runner.inspect().ops).toHaveLength(0);
  });
});

describe('BoardWriteEngine · 幂等（§6.5-1）', () => {
  it('重复提交同一 clientOpId：返回原 seq，不新增 op，不改状态', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    const clientOpId = uid(201);
    const input = { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId };

    const first = expectApplied(await runner.run((tx) => engine.createShape(tx, input)));
    expect(first.seq).toBe(1);

    const replay = await runner.run((tx) => engine.createShape(tx, input));
    expect(replay.status).toBe('duplicate');
    if (replay.status !== 'duplicate') throw new Error('unreachable');
    expect(replay.seq).toBe(first.seq);
    expect(replay.reason).toBe('client_op_id');

    // 副作用检查：op 数、lastSeq、投影版本都没变
    const snapshot = runner.inspect();
    expect(snapshot.ops).toHaveLength(1);
    expect(snapshot.boards.get(BOARD_ID)?.lastSeq).toBe(1);
    expect(snapshot.shapes).toHaveLength(1);
    expect(snapshot.shapes[0]?.version).toBe(1);
  });

  it('update 的重复提交同样命中幂等（版本不会涨到 3）', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );

    const update = {
      boardId: BOARD_ID,
      actorId: USER_A,
      shapeId: shape.id,
      patch: { x: 999 },
      baseVersion: 1,
      clientOpId: uid(202),
    };
    const first = expectApplied(await runner.run((tx) => engine.updateShape(tx, update)));
    expect(first.serverShape?.version).toBe(2);

    const replay = await runner.run((tx) => engine.updateShape(tx, update));
    expect(replay.status).toBe('duplicate');
    if (replay.status !== 'duplicate') throw new Error('unreachable');
    expect(replay.seq).toBe(first.seq);
    expect(replay.serverShape?.version).toBe(2);
    expect(runner.inspect().ops).toHaveLength(2);
  });

  it('换了 clientOpId 重试的 create：按 shape.id 命中，不重复建图形', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );

    const again = await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(202) }),
    );
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') throw new Error('unreachable');
    expect(again.reason).toBe('shape_exists');
    expect(runner.inspect().ops).toHaveLength(1);
    expect(runner.inspect().shapes).toHaveLength(1);
  });

  it('删除已删除的图形是幂等空操作', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );
    const del = { boardId: BOARD_ID, actorId: USER_A, shapeId: shape.id, clientOpId: uid(202) };
    expectApplied(await runner.run((tx) => engine.deleteShape(tx, del)));

    const second = await runner.run((tx) =>
      engine.deleteShape(tx, { ...del, clientOpId: uid(203) }),
    );
    expect(second.status).toBe('duplicate');
    if (second.status !== 'duplicate') throw new Error('unreachable');
    expect(second.reason).toBe('already_deleted');
    expect(runner.inspect().ops).toHaveLength(2);
  });
});

describe('BoardWriteEngine · 乐观并发（§7.5）', () => {
  it('baseVersion 一致 → 应用 patch、version+1', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101), style: { stroke: '#111111', fill: '#222222' } });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );

    const outcome = expectApplied(
      await runner.run((tx) =>
        engine.updateShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          shapeId: shape.id,
          patch: { x: 500, style: { stroke: '#ff0000' } },
          baseVersion: 1,
          clientOpId: uid(202),
        }),
      ),
    );
    const wire = toWireShape(outcome.serverShape!);
    expect(wire.version).toBe(2);
    expect(wire.x).toBe(500);
    // style 是浅合并：只改 stroke，fill 保留
    expect(wire.style).toEqual({ stroke: '#ff0000', fill: '#222222' });
  });

  it('baseVersion 落后 → VERSION_CONFLICT，并带回最新 serverShape（无副作用）', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );

    // 客户端 A 先改成功
    await runner.run((tx) =>
      engine.updateShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shapeId: shape.id,
        patch: { x: 111 },
        baseVersion: 1,
        clientOpId: uid(202),
      }),
    );

    // 客户端 B 还拿着 version=1 改 → 被拒
    const conflict = await runner.run((tx) =>
      engine.updateShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_B,
        shapeId: shape.id,
        patch: { x: 222 },
        baseVersion: 1,
        clientOpId: uid(203),
      }),
    );
    expect(conflict.status).toBe('rejected');
    if (conflict.status !== 'rejected') throw new Error('unreachable');
    expect(conflict.code).toBe('VERSION_CONFLICT');
    expect(conflict.serverShape?.version).toBe(2);
    expect(conflict.serverShape?.x).toBe(111);

    // 被拒不留痕：没有新 op、lastSeq 不动、投影不变
    const snapshot = runner.inspect();
    expect(snapshot.ops).toHaveLength(2);
    expect(snapshot.boards.get(BOARD_ID)?.lastSeq).toBe(2);
    expect(snapshot.shapes[0]?.x).toBe(111);
    expect(snapshot.shapes[0]?.version).toBe(2);
  });

  it('对已删除图形的 update 被拒（CONFLICT），不改状态', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );
    await runner.run((tx) =>
      engine.deleteShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shapeId: shape.id,
        clientOpId: uid(202),
      }),
    );

    const outcome = await runner.run((tx) =>
      engine.updateShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shapeId: shape.id,
        patch: { x: 1 },
        baseVersion: 2,
        clientOpId: uid(203),
      }),
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.code).toBe('CONFLICT');
    expect(runner.inspect().ops).toHaveLength(2);
  });

  it('两个并发 update 只有一个成功（顺序进入事务时后到的被拒）', async () => {
    const { runner, engine } = setupHarness();
    const shape = makeShape({ id: uid(101) });
    await runner.run((tx) =>
      engine.createShape(tx, { boardId: BOARD_ID, actorId: USER_A, shape, clientOpId: uid(201) }),
    );

    const [r1, r2] = await Promise.all([
      runner.run((tx) =>
        engine.updateShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          shapeId: shape.id,
          patch: { x: 1 },
          baseVersion: 1,
          clientOpId: uid(202),
        }),
      ),
      runner.run((tx) =>
        engine.updateShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_B,
          shapeId: shape.id,
          patch: { x: 2 },
          baseVersion: 1,
          clientOpId: uid(203),
        }),
      ),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['applied', 'rejected']);
    expect(runner.inspect().ops).toHaveLength(2);
    expect(runner.inspect().shapes[0]?.version).toBe(2);
  });
});

describe('BoardWriteEngine · batch（批量原子性）', () => {
  it('多条 op 连续分配 seq，且 ack 用的 seq 与 op log 一致', async () => {
    const { runner, engine } = setupHarness();
    const outcome = await runner.run((tx) =>
      engine.applyBatch(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        ops: [
          makeOp({
            opType: 'create',
            shapeId: uid(101),
            clientOpId: uid(201),
            shape: makeShape({ id: uid(101) }),
          }),
          makeOp({
            opType: 'create',
            shapeId: uid(102),
            clientOpId: uid(202),
            shape: makeShape({ id: uid(102) }),
          }),
          makeOp({ opType: 'update', shapeId: uid(101), clientOpId: uid(203), patch: { x: 42 } }),
        ],
      }),
    );
    expect(outcome.map((o) => (o.status === 'applied' ? o.seq : -1))).toEqual([1, 2, 3]);
    expect(runner.inspect().ops.map((op) => op.seq)).toEqual([1, 2, 3]);
    // 最后一条 update 生效
    const shape = runner.inspect().shapes.find((s) => s.id === uid(101));
    expect(shape?.x).toBe(42);
    expect(shape?.version).toBe(2);
  });

  it('一条被拒 → 整批回滚，一条也不写', async () => {
    const { runner, engine } = setupHarness();
    await expect(
      runner.run((tx) =>
        engine.applyBatch(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          ops: [
            makeOp({
              opType: 'create',
              shapeId: uid(101),
              clientOpId: uid(201),
              shape: makeShape({ id: uid(101) }),
            }),
            // 这条指向不存在的图形 → 整批失败
            makeOp({ opType: 'update', shapeId: uid(777), clientOpId: uid(202), patch: { x: 5 } }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const snapshot = runner.inspect();
    expect(snapshot.ops).toHaveLength(0);
    expect(snapshot.shapes).toHaveLength(0);
    expect(snapshot.boards.get(BOARD_ID)?.lastSeq).toBe(0);
  });

  it('重放整批：已提交的子 op 命中幂等，未提交的补上', async () => {
    const { runner, engine } = setupHarness();
    const ops = [
      makeOp({
        opType: 'create',
        shapeId: uid(101),
        clientOpId: uid(201),
        shape: makeShape({ id: uid(101) }),
      }),
      makeOp({ opType: 'update', shapeId: uid(101), clientOpId: uid(202), patch: { y: 7 } }),
    ];
    await runner.run((tx) => engine.applyBatch(tx, { boardId: BOARD_ID, actorId: USER_A, ops }));

    // 假设客户端没收到 ack，整批重发
    const replay = await runner.run((tx) =>
      engine.applyBatch(tx, { boardId: BOARD_ID, actorId: USER_A, ops }),
    );
    expect(replay.every((o) => o.status === 'duplicate')).toBe(true);
    expect(replay.map((o) => (o.status === 'rejected' ? -1 : o.seq))).toEqual([1, 2]);
    expect(runner.inspect().ops).toHaveLength(2);
    // 幂等命中不叠加版本
    expect(runner.inspect().shapes[0]?.version).toBe(2);
  });

  it('batch 里的 reorder 只改 zIndex，且 op log 记成顶层 zIndex（客户端回放依赖这个形状）', async () => {
    const { runner, engine } = setupHarness();
    await runner.run((tx) =>
      engine.createShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shape: makeShape({ id: uid(101), zIndex: 0 }),
        clientOpId: uid(201),
      }),
    );
    const outcomes = await runner.run((tx) =>
      engine.applyBatch(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        ops: [makeOp({ opType: 'reorder', shapeId: uid(101), clientOpId: uid(202), zIndex: 15 })],
      }),
    );
    const shape = runner.inspect().shapes[0];
    expect(shape?.zIndex).toBe(15);
    expect(shape?.x).toBe(10);

    // op 行：opType=reorder + payload.zIndex（而不是 payload.patch.zIndex）
    const opRow = runner.inspect().ops.find((op) => op.clientOpId === uid(202));
    expect(opRow?.opType).toBe('reorder');
    expect(opRow?.payload).toEqual({ zIndex: 15 });

    // 下发给客户端的 wire op 也带顶层 zIndex
    const applied = outcomes[0];
    expect(applied?.status).toBe('applied');
    if (applied?.status !== 'applied') throw new Error('unreachable');
    expect(toWireOp(applied.op).zIndex).toBe(15);
  });
});

describe('BoardWriteEngine · 快照（§5.4：每 200 op 或每 60s）', () => {
  it('达到 op 阈值时写快照，且快照 seq 与 lastSeq 对齐', async () => {
    const { runner, engine } = setupHarness({ snapshotEveryOps: 3, snapshotEveryMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      await runner.run((tx) =>
        engine.createShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          shape: makeShape({ id: uid(100 + i) }),
          clientOpId: uid(200 + i),
        }),
      );
    }
    const snapshot = runner.inspect().snapshots.get(BOARD_ID);
    expect(snapshot?.seq).toBe(3);
    expect(snapshot?.shapes.map((s) => s.id).sort()).toEqual([uid(100), uid(101), uid(102)].sort());
  });

  it('未到阈值时不写快照', async () => {
    const { runner, engine } = setupHarness({ snapshotEveryOps: 200, snapshotEveryMs: 60_000 });
    await runner.run((tx) =>
      engine.createShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shape: makeShape({ id: uid(101) }),
        clientOpId: uid(201),
      }),
    );
    expect(runner.inspect().snapshots.size).toBe(0);
  });

  it('快照老化到 60s 后，新的写操作会补一次快照', async () => {
    const { runner, engine } = setupHarness({ snapshotEveryOps: 1000, snapshotEveryMs: 60_000 });
    // 先制造一个快照：把阈值临时压到 1
    const quick = new BoardWriteEngine({ snapshotEveryOps: 1, snapshotEveryMs: 60_000 });
    await runner.run((tx) =>
      quick.createShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shape: makeShape({ id: uid(101) }),
        clientOpId: uid(201),
      }),
    );
    expect(runner.inspect().snapshots.get(BOARD_ID)?.seq).toBe(1);

    runner.ageSnapshots(61_000);
    await runner.run((tx) =>
      engine.createShape(tx, {
        boardId: BOARD_ID,
        actorId: USER_A,
        shape: makeShape({ id: uid(102) }),
        clientOpId: uid(202),
      }),
    );
    expect(runner.inspect().snapshots.get(BOARD_ID)?.seq).toBe(2);
  });
});

describe('BoardWriteEngine · 断线补齐（§6.6 / §7.2）', () => {
  async function seedOps(count: number, snapshotEveryOps = 1000) {
    const harness = setupHarness({ snapshotEveryOps, snapshotEveryMs: 60_000 });
    for (let i = 0; i < count; i += 1) {
      await harness.runner.run((tx) =>
        harness.engine.createShape(tx, {
          boardId: BOARD_ID,
          actorId: USER_A,
          shape: makeShape({ id: uid(100 + i) }),
          clientOpId: uid(200 + i),
        }),
      );
    }
    return harness;
  }

  it('sinceSeq 已是最新 → 空 ops（客户端已对齐）', async () => {
    const { runner, engine } = await seedOps(3);
    const sync = await runner.run((tx) => engine.sync(tx, { boardId: BOARD_ID, sinceSeq: 3 }));
    expect(sync).toMatchObject({ kind: 'ops', fromSeq: 4, latestSeq: 3 });
    expect(sync.ops).toEqual([]);
  });

  it('窗口内 → 增量 ops，fromSeq = sinceSeq + 1', async () => {
    const { runner, engine } = await seedOps(5);
    const sync = await runner.run((tx) => engine.sync(tx, { boardId: BOARD_ID, sinceSeq: 2 }));
    expect(sync.kind).toBe('ops');
    expect(sync.fromSeq).toBe(3);
    expect(sync.latestSeq).toBe(5);
    expect(sync.ops?.map((op) => op.seq)).toEqual([3, 4, 5]);
    // 增量 op 是可回放的 wire 形状（带 shape / seq / createdAt）
    expect(sync.ops?.[0]?.shape?.id).toBe(uid(102));
    expect(sync.ops?.[0]?.clientOpId).toBe(uid(202));
  });

  it('sinceSeq 早于快照 → 回落到全量 state（恢复永远可行）', async () => {
    // 阈值 3：第 3 次写会落一个 seq=3 的快照
    const { runner, engine } = await seedOps(4, 3);
    expect(runner.inspect().snapshots.get(BOARD_ID)?.seq).toBe(3);

    const sync = await runner.run((tx) => engine.sync(tx, { boardId: BOARD_ID, sinceSeq: 1 }));
    expect(sync.kind).toBe('state');
    expect(sync.latestSeq).toBe(4);
    expect(sync.shapes?.map((s) => s.id).sort()).toEqual(
      [uid(100), uid(101), uid(102), uid(103)].sort(),
    );
  });

  it('快照之后但仍够得着 op log → 增量（快照不挡增量路径）', async () => {
    const { runner, engine } = await seedOps(4, 3);
    const sync = await runner.run((tx) => engine.sync(tx, { boardId: BOARD_ID, sinceSeq: 3 }));
    expect(sync.kind).toBe('ops');
    expect(sync.ops?.map((op) => op.seq)).toEqual([4]);
  });

  it('board 不存在 → NOT_FOUND', async () => {
    const { runner, engine } = setupHarness();
    await expect(
      runner.run((tx) => engine.sync(tx, { boardId: uid(999), sinceSeq: 0 })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('BoardWriteEngine · 投影 == op log 回放', () => {
  it('一串混合操作后，rebuildFromLog（快照 + 回放）与投影逐字段一致', async () => {
    const { runner, engine } = setupHarness({ snapshotEveryOps: 4, snapshotEveryMs: 60_000 });
    const boardId = BOARD_ID;

    // create 3 → update → delete → batch（create + reorder）→ update
    await runner.run((tx) =>
      engine.createShape(tx, {
        boardId,
        actorId: USER_A,
        shape: makeShape({ id: uid(101) }),
        clientOpId: uid(201),
      }),
    );
    await runner.run((tx) =>
      engine.createShape(tx, {
        boardId,
        actorId: USER_A,
        shape: makeShape({ id: uid(102), zIndex: 2 }),
        clientOpId: uid(202),
      }),
    );
    await runner.run((tx) =>
      engine.createShape(tx, {
        boardId,
        actorId: USER_A,
        shape: makeShape({ id: uid(103), type: 'text' }),
        clientOpId: uid(203),
      }),
    );
    await runner.run((tx) =>
      engine.updateShape(tx, {
        boardId,
        actorId: USER_A,
        shapeId: uid(101),
        patch: { x: 77, style: { fill: '#00ff00' } },
        baseVersion: 1,
        clientOpId: uid(204),
      }),
    );
    await runner.run((tx) =>
      engine.deleteShape(tx, { boardId, actorId: USER_A, shapeId: uid(102), clientOpId: uid(205) }),
    );
    await runner.run((tx) =>
      engine.applyBatch(tx, {
        boardId,
        actorId: USER_B,
        ops: [
          makeOp({
            opType: 'create',
            shapeId: uid(104),
            clientOpId: uid(206),
            shape: makeShape({ id: uid(104), zIndex: 1 }),
          }),
          makeOp({ opType: 'reorder', shapeId: uid(103), clientOpId: uid(207), zIndex: 9 }),
        ],
      }),
    );

    const projection = await runner.run((tx) => engine.fullState(tx, boardId));
    const rebuilt = await runner.run((tx) => engine.rebuildFromLog(tx, boardId));

    // 7 个 op（3 create + 1 update + 1 delete + 1 batch 里的 2 条）→ lastSeq = 7
    expect(rebuilt.seq).toBe(7);
    expect(projection).toHaveLength(3);
    expect(rebuilt.shapes).toEqual(projection);
    // 删掉的 102 不在任何一侧
    expect(projection.map((s) => s.id)).not.toContain(uid(102));
  });
});
