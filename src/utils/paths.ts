/**
 * 路径安全：硬约束 1 的唯一执法点。
 *
 * 规则（按顺序，全部命中即抛 SystemDriveError）：
 *   1. 解析环境变量后必须是绝对路径；
 *   2. 盘符不允许是 C:（D:\AI_Memory 默认值因此安全）；
 *   3. 任意层级出现 AppData / AppData\Roaming 都拒绝；
 *   4. 目录必须真实可写（建目录 + 写探针文件）。
 *
 * 这里不做任何“自动改到 D 盘”的兜底：静默换路径会让用户以为记忆在，
 * 实际写到别处。宁可启动失败，也不悄悄换地方。
 */

import fs from 'node:fs';
import path from 'node:path';

import { StorageInitError, SystemDriveError } from '../errors.js';

export interface MemoryPaths {
  /** 用户配置的根目录，例如 D:\AI_Memory。 */
  root: string;
  /** SQLite 单文件。 */
  dbFile: string;
  /** Markdown 人读档案根目录（可与 root 不同盘）。 */
  archiveRoot: string;
  /** 本地 embedding 模型缓存。 */
  modelsDir: string;
  /** 插件自身日志。 */
  logsDir: string;
}

const ENV_PATTERN = /%([A-Za-z_][A-Za-z0-9_]*)%/g;
const UNRESOLVED_ENV = /%[^%]+%/;
const EXTENDED_PREFIX = /^\\\\\?\\/;
const DRIVE_LETTER = /^([a-zA-Z]):(?:[\\/]|$)/;
const APP_DATA_SEGMENT = /(^|[\\/])appdata([\\/]|$)/i;

function expandEnvironment(input: string): string {
  return input.replace(ENV_PATTERN, (match, name: string) => {
    const value = process.env[name];
    return value === undefined ? match : value;
  });
}

/** 归一化为绝对目录路径；只做语法归一，不做盘符豁免。 */
export function normalizeMemoryRoot(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new StorageInitError('memoryDbPath 不能为空。', {
      hint: '默认值是 D:\\AI_Memory；请提供一个非 C: 盘的绝对路径。',
    });
  }

  const expanded = expandEnvironment(raw);
  if (UNRESOLVED_ENV.test(expanded)) {
    throw new StorageInitError(`memoryDbPath 含无法解析的环境变量：${raw}`, {
      hint: '请直接写绝对路径，例如 D:\\AI_Memory。',
    });
  }

  const resolved = path.resolve(expanded);
  const trimmed = resolved.replace(/[\\/]+$/, '');
  return trimmed || resolved;
}

/**
 * 判断并拦截系统盘 / AppData。
 * 支持 \\?\C:\... 扩展路径前缀；UNC 路径不按盘符判断，交给后面的 WAL 检查。
 */
export function assertNotSystemPath(target: string): void {
  const normalized = target.replace(/\//g, '\\');
  const plain = normalized.replace(EXTENDED_PREFIX, '');

  const drive = DRIVE_LETTER.exec(plain);
  if (drive?.[1]?.toUpperCase() === 'C') {
    throw new SystemDriveError(target);
  }

  if (APP_DATA_SEGMENT.test(plain)) {
    throw new SystemDriveError(target);
  }
}

/** 配置 → 具体路径。archiveRoot 为 null 时跟随 memoryDbPath。 */
export function resolveMemoryPaths(
  memoryDbPath: string,
  archiveRoot?: string | null,
): MemoryPaths {
  const root = normalizeMemoryRoot(memoryDbPath);
  assertNotSystemPath(root);

  const archive = archiveRoot?.trim() ? normalizeMemoryRoot(archiveRoot) : root;
  assertNotSystemPath(archive);

  return {
    root,
    dbFile: path.join(root, 'memory.db'),
    archiveRoot: archive,
    modelsDir: path.join(root, '.models'),
    logsDir: path.join(root, 'logs'),
  };
}

/** 候选盘符：永远跳过 C 盘（系统盘）。 */
const CANDIDATE_DRIVES = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 当前真实存在、且不是 C 盘的盘符，按 D→Z 顺序。 */
export function detectAvailableDrives(): string[] {
  return CANDIDATE_DRIVES.filter((letter) => {
    try {
      return fs.existsSync(`${letter}:\\`);
    } catch {
      return false;
    }
  });
}

/** 目录能否真正写入（建目录 + 写探针 + 清理）。 */
function isWritableRoot(root: string): boolean {
  const probe = path.join(root, `.apm-probe-${process.pid}.tmp`);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // 清理失败不影响判断
    }
  }
}

export interface MemoryRootChoice {
  /** 最终采用（或建议）的记忆根目录。 */
  root: string;
  /** configured = 用户指定且可用；auto = 自动选到了别的盘。 */
  source: 'configured' | 'auto';
  /** 给日志看的一句话说明（自动改路径时非空）。 */
  note?: string;
}

/**
 * 选盘：优先用户配置，其次自动找一个可写的非系统盘。
 *
 * 之所以要有这一步：默认值 `D:\AI_Memory` 在只有 C 盘的机器上根本不存在，
 * 直接抛错会让「装上但用不了」——普通用户不知道要改配置。
 *
 * 规则：
 *   1. 用户显式给了路径且该盘存在 → 原样使用；
 *   2. 该盘不存在 → 按 D→E→F… 找第一个可写的非 C 盘，落到 `<盘>:\AI_Memory`；
 *   3. 一个可用盘都没有 → 返回原值，让上层照旧抛清晰错误（绝不静默写 C 盘）。
 *   4. 用户显式给 C 盘 → 原样返回，交给 SystemDriveError 拦截（安全红线不动）。
 */
export function pickMemoryRoot(preferred?: string | null): MemoryRootChoice {
  const explicit = (preferred ?? '').trim();

  if (explicit) {
    const driveMatch = DRIVE_LETTER.exec(explicit.replace(/\//g, '\\'));
    const drive = driveMatch?.[1]?.toUpperCase();

    // 显式指向系统盘：不做任何“好心”替换，交给路径闸门报错。
    if (drive === 'C') return { root: explicit, source: 'configured' };

    if (drive !== undefined) {
      try {
        if (fs.existsSync(`${drive}:\\`)) return { root: explicit, source: 'configured' };
      } catch {
        // 盘符探测失败时继续走自动选盘
      }
    } else {
      // 不是盘符开头（相对路径/UNC）：原样返回，交给 normalize 处理。
      return { root: explicit, source: 'configured' };
    }
  }

  const drives = detectAvailableDrives();
  for (const letter of drives) {
    const candidate = `${letter}:\\AI_Memory`;
    if (isWritableRoot(candidate)) {
      const choice: MemoryRootChoice = { root: candidate, source: 'auto' };
      if (explicit) {
        choice.note = `配置的 ${explicit} 所在磁盘不可用，已自动改用 ${candidate}`;
      } else if (candidate.toLowerCase() !== DEFAULT_MEMORY_ROOT_FALLBACK.toLowerCase()) {
        choice.note = `未找到 D 盘，已自动改用 ${candidate}`;
      }
      return choice;
    }
  }

  const noDriveNote = '没有找到任何非系统盘，请把 memoryDbPath 指向一个可用的非 C 盘。';
  return drives.length === 0
    ? { root: explicit || DEFAULT_MEMORY_ROOT_FALLBACK, source: 'configured', note: noDriveNote }
    : { root: explicit || DEFAULT_MEMORY_ROOT_FALLBACK, source: 'configured' };
}

/** 与 types.ts 的 DEFAULT_MEMORY_ROOT 保持一致（此处避免循环依赖）。 */
const DEFAULT_MEMORY_ROOT_FALLBACK = 'D:\\AI_Memory';

/** 建目录并做一次真实写探针，避免“能建目录但写不进文件”的只读盘。 */
export function ensureMemoryDirectories(paths: MemoryPaths): void {  const directories = [paths.root, paths.archiveRoot, paths.modelsDir, paths.logsDir];

  for (const dir of directories) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new StorageInitError(`无法创建记忆目录：${dir}`, {
        cause: error,
        hint: '检查磁盘是否存在、是否只读、是否有权限。',
      });
    }
  }

  const probe = path.join(paths.root, `.apm-write-probe-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
  } catch (error) {
    throw new StorageInitError(`记忆目录不可写：${paths.root}`, {
      cause: error,
      hint: '换一个可写目录，或检查杀毒软件/权限设置。',
    });
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // 探针清理失败不影响主流程
    }
  }
}

/**
 * 单段目录/文件名消毒：用于 mask uid、project slug。
 * 拒绝路径分隔符、点目录、Windows 保留字符与尾部空格/点。
 */
export function sanitizeSegment(value: string, fallback = '_'): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .trim();

  const safe = cleaned.slice(0, 64).replace(/[. ]+$/g, '');
  return safe || fallback;
}

/** child 是否在 parent 之内（含相等）。 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** ANSI 红色；在非 TTY（日志文件/CI）里也可读。 */
export function paintRed(text: string): string {
  return `\u001b[31m${text}\u001b[0m`;
}

/** 初始化阶段的红色警告：先打红字，再把原始错误抛给调用方。 */
export function printSystemDriveAlert(error: SystemDriveError): void {
  const lines = [
    '',
    '✖ ai-persistent-memory 拒绝启动：记忆库路径不安全',
    `  ${error.message}`,
    ...(error.hint ? [`  ${error.hint}`] : []),
    '  已中止：不会创建数据库，也不会悄悄退回到 C 盘。',
    '',
  ];
  process.stderr.write(`${paintRed(lines.join('\n'))}\n`);
}
