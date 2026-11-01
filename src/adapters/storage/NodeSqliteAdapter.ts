/**
 * node:sqlite 适配器 —— 给 Electron / Node 24 宿主用。
 *
 * 为什么需要它：
 *   better-sqlite3 是「为某个 Node ABI 编译」的原生模块。DSH 桌面端跑在
 *   Electron 主进程里，Electron 的 NODE_MODULE_VERSION 与系统 Node 不一致，
 *   直接 require 会报 `NODE_MODULE_VERSION xxx. This version of Node.js requires
 *   NODE_MODULE_VERSION yyy`。node:sqlite 是进程内置模块，没有 ABI 问题，
 *   也不需要 MSVC 编译。
 *
 * 只实现引擎实际用到的那部分 better-sqlite3 子集：
 *   pragma / exec / prepare(run|get|all) / transaction(deferred|immediate|exclusive) / close
 *
 * 用 TypeScript 严格模式为 `Database.Database`（better-sqlite3 类型）做结构兼容，
 * 因此对外仍然是标准的 SqliteDatabase。
 */

import { createRequire } from 'node:module';

import type { SqliteDatabase } from '../../core/schema.js';

/** node:sqlite 的最小类型声明（@types/node 的覆盖范围随版本变化，这里自描述）。 */
interface NodeSqliteStatement {
  run(...params: readonly unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
  all(...params: readonly unknown[]): Record<string, unknown>[];
}

interface NodeSqliteDatabaseLike {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (file: string, options?: Record<string, unknown>) => NodeSqliteDatabaseLike;
}

const requireFromHere = createRequire(import.meta.url);

/** node:sqlite 是否可用（Electron ≥ 30 / Node ≥ 22.5）。 */
export function hasNodeSqlite(): boolean {
  try {
    requireFromHere('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * 打开一个 node:sqlite 连接，并包成 better-sqlite3 的形状。
 *
 * 失败时抛错，让调用方回落到 better-sqlite3；绝不静默降级成「内存库」，
 * 否则用户会以为记忆写进去了。
 */
export function openNodeSqliteDatabase(file: string): SqliteDatabase {
  const sqlite = requireFromHere('node:sqlite') as NodeSqliteModule;
  return new NodeSqliteCompat(new sqlite.DatabaseSync(file)) as unknown as SqliteDatabase;
}

class NodeSqliteCompat {
  constructor(private readonly db: NodeSqliteDatabaseLike) {}

  pragma(source: string, options?: { simple?: boolean }): unknown {
    if (options?.simple === true) {
      const row = this.db.prepare(`PRAGMA ${source}`).get();
      return row === undefined ? undefined : Object.values(row)[0];
    }

    this.db.exec(`PRAGMA ${source}`);
    return undefined;
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  prepare(sql: string): {
    run: (...params: readonly unknown[]) => { changes: number; lastInsertRowid: number };
    get: (...params: readonly unknown[]) => Record<string, unknown> | undefined;
    all: (...params: readonly unknown[]) => Record<string, unknown>[];
  } {
    const statement = this.db.prepare(sql);

    return {
      run: (...params: readonly unknown[]) => {
        const result = statement.run(...params);
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        };
      },
      get: (...params: readonly unknown[]) => statement.get(...params),
      all: (...params: readonly unknown[]) => statement.all(...params),
    };
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): ((...args: TArgs) => TResult) & {
    deferred: (...args: TArgs) => TResult;
    immediate: (...args: TArgs) => TResult;
    exclusive: (...args: TArgs) => TResult;
  } {
    const deferred = (...args: TArgs) => this.runTransaction('DEFERRED', fn, args);
    const immediate = (...args: TArgs) => this.runTransaction('IMMEDIATE', fn, args);
    const exclusive = (...args: TArgs) => this.runTransaction('EXCLUSIVE', fn, args);

    return Object.assign(deferred, { deferred, immediate, exclusive });
  }

  close(): void {
    this.db.close();
  }

  private runTransaction<TArgs extends unknown[], TResult>(
    mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE',
    fn: (...args: TArgs) => TResult,
    args: TArgs,
  ): TResult {
    this.db.exec(`BEGIN ${mode}`);
    try {
      const result = fn(...args);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite 可能已自动回滚（例如死锁），忽略二次回滚失败
      }
      throw error;
    }
  }
}
