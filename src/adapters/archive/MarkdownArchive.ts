/**
 * 图②「存成两份」的人读那一份：Markdown 档案。
 *
 * 布局（与目录设计一致，中文命名）：
 *   <archiveRoot>\01_记忆\事实.md / 看法.md / 观察.md / 事件.md
 *   <archiveRoot>\01_记忆\面具\<uid>\<类别>.md
 *   <archiveRoot>\01_记忆\项目\<slug>\<类别>.md
 *   <archiveRoot>\01_记忆\情绪账.md          （强度 ≥ 6，跨线共享）
 *   <archiveRoot>\02_日记\每天的流水\<日期>.md
 *
 * 一致性策略：每次写入都「读全文 → 改 → 临时文件 → rename」，
 * 单文件层面是原子的。append 在 SQLite 事务内同步调用，档案写失败会抛出，
 * 由事务回滚数据库；已成功的其他文件由 appendMemory 自己回滚。
 *
 * 注意：这是「人的档案」，不做摘要改写（原则一），原文按行引用保存。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { StorageInitError } from '../../errors.js';
import {
  MEMORY_KIND_LABEL,
  SCOPE_LABEL,
  type MemoryRecord,
} from '../../types.js';
import { sanitizeSegment, type MemoryPaths } from '../../utils/paths.js';

export interface MemoryArchive {
  appendMemory(record: MemoryRecord): void;
  removeMemory(record: MemoryRecord): void;
}

/** archive.enabled=false 或纯检索场景使用。 */
export class NullArchive implements MemoryArchive {
  appendMemory(_record: MemoryRecord): void {
    // 故意留空：关闭档案时只保留 SQLite 索引。
  }

  removeMemory(_record: MemoryRecord): void {
    // 故意留空。
  }
}

export class MarkdownArchive implements MemoryArchive {
  constructor(private readonly paths: MemoryPaths) {}

  appendMemory(record: MemoryRecord): void {
    const touched: string[] = [];

    try {
      const kindFile = this.kindFileFor(record);
      this.appendBlock(kindFile, this.kindHeader(record), this.renderBlock(record));
      touched.push(kindFile);

      const dailyFile = this.dailyFileFor(record);
      this.appendLine(
        dailyFile,
        `# ${localDate(record.createdAt)} · 每天的流水\n\n> ai-persistent-memory · 人读日志，按写入时间追加。\n`,
        `- ${localTime(record.createdAt)} · [${MEMORY_KIND_LABEL[record.kind]}] ${oneLine(record.layers.fact)} <!-- apm:id=${record.id} -->`,
      );
      touched.push(dailyFile);

      if (record.layers.intensity >= 6) {
        const emotionFile = this.emotionFile();
        this.appendBlock(
          emotionFile,
          '# 情绪账\n\n> 强度 ≥ 6 的记忆按时间记账；跨线共享（图⑥）。\n',
          [
            `<!-- apm:id=${record.id} -->`,
            `- ${localDateTime(record.createdAt)} · 强度 ${record.layers.intensity.toFixed(1)}/10 · ` +
              `[${MEMORY_KIND_LABEL[record.kind]}] ${oneLine(record.layers.fact)} · 范围：${scopeLabel(record)}`,
            `<!-- /apm:id=${record.id} -->`,
          ].join('\n'),
        );
        touched.push(emotionFile);
      }
    } catch (error) {
      // 数据库还没提交，先把已写进去的档案片段清掉，避免「库里没有、档案里有」
      for (const file of touched) {
        try {
          this.stripFile(file, record.id);
        } catch {
          // 回滚档案本身失败时，只能让原始错误冒泡
        }
      }

      throw new StorageInitError(
        `Markdown 档案写入失败：${record.id}`,
        {
          cause: error,
          hint: '检查 archiveRoot 所在磁盘的权限与剩余空间。',
        },
      );
    }
  }

  removeMemory(record: MemoryRecord): void {
    this.stripFile(this.kindFileFor(record), record.id);
    this.stripFile(this.dailyFileFor(record), record.id);
    this.stripFile(this.emotionFile(), record.id);
  }

  /* ─────────────────────────── 路径 ─────────────────────────── */

  private kindFileFor(record: MemoryRecord): string {
    return path.join(
      this.scopeDirectory(record),
      `${MEMORY_KIND_LABEL[record.kind]}.md`,
    );
  }

  private scopeDirectory(record: MemoryRecord): string {
    if (record.scope === 'self') {
      return path.join(this.paths.archiveRoot, '01_记忆');
    }

    const segment = sanitizeSegment(record.scopeRef ?? 'unknown');
    const group = record.scope === 'mask' ? '面具' : '项目';
    return path.join(this.paths.archiveRoot, '01_记忆', group, segment);
  }

  private dailyFileFor(record: MemoryRecord): string {
    return path.join(
      this.paths.archiveRoot,
      '02_日记',
      '每天的流水',
      `${localDate(record.createdAt)}.md`,
    );
  }

  private emotionFile(): string {
    return path.join(this.paths.archiveRoot, '01_记忆', '情绪账.md');
  }

  /* ─────────────────────────── 渲染 ─────────────────────────── */

  private kindHeader(record: MemoryRecord): string {
    return [
      `# ${MEMORY_KIND_LABEL[record.kind]}`,
      '',
      `> ai-persistent-memory 人读档案 · 范围：${scopeLabel(record)}`,
      '> 原则一：原文不压缩。本文件由 SQLite 索引同步生成。',
      '',
    ].join('\n');
  }

  private renderBlock(record: MemoryRecord): string {
    const lines: string[] = [
      `<!-- apm:id=${record.id} -->`,
      `## ${localDateTime(record.occurredAt)} · ${MEMORY_KIND_LABEL[record.kind]} · ` +
        `强度 ${record.layers.intensity.toFixed(1)}/10 · 权重 ${record.weight.toFixed(2)}`,
      '',
      `- **事实**：${oneLine(record.layers.fact)}`,
    ];

    if (record.layers.feltThen) lines.push(`- **当时感觉**：${oneLine(record.layers.feltThen)}`);
    if (record.layers.thoughtThen) lines.push(`- **当时在想**：${oneLine(record.layers.thoughtThen)}`);
    if (record.layers.reframe) lines.push(`- **后来再想**：${oneLine(record.layers.reframe)}`);
    if (record.layers.recalledLater) lines.push(`- **回忆补**：${oneLine(record.layers.recalledLater)}`);

    lines.push('- **原文**：');
    for (const rawLine of record.rawText.split(/\r?\n/)) {
      lines.push(`  > ${rawLine}`);
    }

    lines.push(`- **范围**：${scopeLabel(record)}`);
    lines.push(
      `- **标签**：${record.tags.length > 0 ? record.tags.map((tag) => `#${tag}`).join(' ') : '—'}`,
    );
    lines.push(`<!-- /apm:id=${record.id} -->`);

    return lines.join('\n');
  }

  /* ─────────────────────────── 文件操作 ─────────────────────────── */

  private appendBlock(file: string, header: string, block: string): void {
    const existing = this.readIfExists(file) ?? header;
    const stripped = stripId(existing, blockId(block));
    const next = `${stripped.trimEnd()}\n\n${block}\n`;
    this.writeAtomic(file, next);
  }

  private appendLine(file: string, header: string, line: string): void {
    const existing = this.readIfExists(file) ?? header;
    const next = existing.endsWith('\n') ? `${existing}${line}\n` : `${existing}\n${line}\n`;
    this.writeAtomic(file, next);
  }

  private stripFile(file: string, id: string): void {
    const existing = this.readIfExists(file);
    if (existing === null) return;

    const next = stripId(existing, id);
    if (next !== existing) {
      this.writeAtomic(file, next);
    }
  }

  private readIfExists(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private writeAtomic(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;

    try {
      fs.writeFileSync(temp, content, 'utf8');
      fs.renameSync(temp, file);
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // 清理临时文件失败不掩盖原始错误
      }
      throw error;
    }
  }
}

/* ─────────────────────────── 纯函数 ─────────────────────────── */

function blockId(block: string): string {
  const match = /<!-- apm:id=([^\s]+) -->/.exec(block);
  return match?.[1] ?? '';
}

/** 删除指定 id 的整块或单行标记；行扫描实现，容忍文件被手工编辑。 */
function stripId(content: string, id: string): string {
  if (!id) return content;

  const start = `<!-- apm:id=${id} -->`;
  const end = `<!-- /apm:id=${id} -->`;
  const kept: string[] = [];
  let skipping = false;

  for (const line of content.split('\n')) {
    if (skipping) {
      if (line.includes(end)) skipping = false;
      continue;
    }

    // 块级标记独占一行；单行标记（流水/情绪账）嵌在正文里
    if (line.trim() === start) {
      skipping = true;
      continue;
    }

    if (line.includes(`apm:id=${id}`)) continue;
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

function scopeLabel(record: MemoryRecord): string {
  const base = SCOPE_LABEL[record.scope];
  return record.scopeRef ? `${base}/${record.scopeRef}` : base;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 物理清除档案里的「插件记忆明文」。
 *
 * 只处理带 `apm:id=` 标记的插件内容，绝不批量删除用户自建的 `.md`：
 *   - 块级：从 `<!-- apm:id=x -->` 删到 `<!-- /apm:id=x -->`；
 *   - 单行：流水/情绪账里带 `apm:id=` 的行整行删掉。
 *
 * @returns 被改写的文件数
 */
export function purgeArchiveMarkdown(archiveRoot: string): number {
  let changed = 0;

  for (const file of listMarkdownFiles(archiveRoot)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (!content.includes('apm:id=')) continue;

    const kept: string[] = [];
    let skipping = false;

    for (const line of content.split('\n')) {
      if (skipping) {
        if (line.includes('<!-- /apm:id=')) skipping = false;
        continue;
      }
      if (/^\s*<!-- apm:id=[^\s]+ -->\s*$/.test(line)) {
        skipping = true;
        continue;
      }
      if (line.includes('apm:id=')) continue;
      kept.push(line);
    }

    const next = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    if (next === content) continue;

    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, next, 'utf8');
      fs.renameSync(temp, file);
      changed += 1;
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // 忽略
      }
    }
  }

  return changed;
}

function listMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  // 备份快照、模型缓存、日志不属于「线上档案」，绝不能在这里被改写。
  const skip = new Set(['backups', '.models', 'logs']);

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
      if (entry.isDirectory()) {
        if (skip.has(entry.name.toLowerCase())) continue;
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full);
    }
  }

  return files;
}

function localDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(11, 16);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDateTime(iso: string): string {
  return `${localDate(iso)} ${localTime(iso)}`;
}
