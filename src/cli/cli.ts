#!/usr/bin/env node
/**
 * 极简 CLI：
 *   ai-memory init  [--path D:\AI_Memory]
 *   ai-memory stats [--path D:\AI_Memory]
 *
 * init 会走完整的路径校验（C:/AppData 直接红字拒绝）、建库、建目录、写 schema；
 * stats 只读：各状态条数、数据库大小、Markdown 档案数量。
 */

import fs from 'node:fs';
import path from 'node:path';

import { MemoryEngine } from '../core/MemoryEngine.js';
import { SCHEMA_VERSION } from '../core/schema.js';
import { SystemDriveError } from '../errors.js';
import { hasNodeSqlite, openNodeSqliteDatabase } from '../adapters/storage/NodeSqliteAdapter.js';
import { pickMemoryRoot } from '../utils/paths.js';

const HELP = `ai-persistent-memory · 本地长效记忆

用法：
  ai-memory init  [--path D:\\AI_Memory]    初始化数据库与目录
  ai-memory stats [--path D:\\AI_Memory]    查看记忆条数与磁盘占用

说明：
  --path 省略时使用默认 D:\\AI_Memory；
  以 C: 开头或包含 AppData 的路径会被拒绝（SystemDriveError）。
`;

interface CliArgs {
  command: string;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let dbPath: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--path' || arg === '--db') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        throw new Error(`${arg} 需要一个目录路径`);
      }
      dbPath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--path=')) {
      dbPath = arg.slice('--path='.length);
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    }
    positional.push(arg);
  }

  return {
    command: positional[0] ?? 'help',
    dbPath,
    help,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function countMarkdown(root: string): number {
  let total = 0;
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) total += 1;
    }
  }

  return total;
}

function printInit(engine: MemoryEngine): void {
  const stats = engine.stats();
  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);

  console.log('');
  console.log('✔ ai-persistent-memory 已初始化');
  console.log(`  根目录   ${engine.paths.root}`);
  console.log(`  数据库   ${engine.paths.dbFile}`);
  console.log(`  档案     ${engine.paths.archiveRoot}`);
  console.log(`  schema   v${SCHEMA_VERSION}`);
  console.log(`  记忆     ${total} 条`);
  console.log('');
  console.log('下一步：设置 DEEPSEEK_API_KEY，然后按 README 接入 DSH。');
}

function printStats(engine: MemoryEngine): void {
  const stats = engine.stats();
  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);

  console.log('');
  console.log('记忆状态');
  console.log('────────');
  for (const [state, count] of Object.entries(stats).sort()) {
    console.log(`  ${state.padEnd(10)} ${String(count).padStart(5)}`);
  }
  if (total === 0) console.log('  （空库）');
  console.log('────────');
  console.log(`  总计${' '.repeat(8)}${String(total).padStart(5)}`);

  let dbSize = 0;
  try {
    dbSize = fs.statSync(engine.paths.dbFile).size;
  } catch {
    dbSize = 0;
  }

  console.log('');
  console.log(`数据库  ${formatBytes(dbSize)}  ${engine.paths.dbFile}`);
  console.log(`档案    ${countMarkdown(engine.paths.archiveRoot)} 个 Markdown  ${engine.paths.archiveRoot}`);
  console.log(`根目录  ${engine.paths.root}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.command === 'help') {
    console.log(HELP);
    return;
  }

  if (args.command !== 'init' && args.command !== 'stats') {
    console.error(`未知命令：${args.command}\n`);
    console.log(HELP);
    process.exitCode = 2;
    return;
  }

  // 与插件同一套驱动策略：优先进程内置 node:sqlite，免原生重编译；
  // 不可用时才回落到 better-sqlite3（由引擎默认实现）。
  // 选盘：没给 --path 时自动避开系统盘。
  const chosen = pickMemoryRoot(args.dbPath === null ? undefined : args.dbPath);
  if (chosen.note) console.warn(chosen.note);

  const engine = new MemoryEngine({
    overrides: { memoryDbPath: chosen.root },
    ...(hasNodeSqlite() ? { openDatabase: openNodeSqliteDatabase } : {}),
  });

  try {
    if (args.command === 'init') printInit(engine);
    else printStats(engine);
  } finally {
    engine.close();
  }
}

main().catch((error: unknown) => {
  // SystemDriveError 已经由引擎打印红色块，这里不再重复
  if (!(error instanceof SystemDriveError)) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
  }
  process.exitCode = 1;
});
