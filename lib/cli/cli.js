#!/usr/bin/env node
const APM_IMPORT_META_URL = require('node:url').pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/cli/cli.ts
var import_node_fs3 = __toESM(require("fs"));
var import_node_path3 = __toESM(require("path"));

// src/core/MemoryEngine.ts
var import_node_crypto3 = require("crypto");
var import_node_module = require("module");

// src/adapters/archive/MarkdownArchive.ts
var import_node_fs2 = __toESM(require("fs"));
var import_node_path2 = __toESM(require("path"));
var import_node_crypto = require("crypto");

// src/errors.ts
var MemoryError = class extends Error {
  code;
  /** 给用户看的一句话建议，例如「换到 D 盘」。 */
  hint;
  constructor(code, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = options.hint;
  }
};
var SystemDriveError = class extends MemoryError {
  path;
  constructor(path4) {
    super(
      "SYSTEM_DRIVE",
      `拒绝把记忆库放在系统盘或 AppData：${path4}`,
      {
        hint: "系统盘重装/重置会直接抹掉记忆。请把 memoryDbPath 指向非 C: 盘，例如 D:\\AI_Memory（目录会自动创建）。"
      }
    );
    this.path = path4;
  }
};
var ConfigError = class extends MemoryError {
  constructor(message, options = {}) {
    super("CONFIG", message, options);
  }
};
var StorageInitError = class extends MemoryError {
  constructor(message, options = {}) {
    super("STORAGE_INIT", message, options);
  }
};
var SchemaVersionError = class extends MemoryError {
  found;
  supported;
  constructor(found, supported) {
    super(
      "SCHEMA_VERSION",
      `数据库 schema 版本为 v${found}，当前代码只支持到 v${supported}。`,
      {
        hint: "请升级 ai-persistent-memory 到匹配版本；不要用旧版本打开新库，否则可能写坏记忆。若确认要回退，请先备份 memory.db。"
      }
    );
    this.found = found;
    this.supported = supported;
  }
};
var InvalidMemoryError = class extends MemoryError {
  constructor(message, options = {}) {
    super("INVALID_MEMORY", message, options);
  }
};

// src/types.ts
var SCOPES = ["self", "mask", "project"];
var HALF_LIFE_DAYS = Object.freeze({
  fact: 90,
  opinion: 60,
  observation: 45,
  event: 30
});
var DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1e3;
var DEDUPE_SIMILARITY_THRESHOLD = 0.92;
var MAX_INTENSITY = 10;
var MAX_WEIGHT = 3;
var EMBEDDING_MODEL = "bge-small-zh-v1.5";
var EMBEDDING_DIM = 512;
var MEMORY_KIND_LABEL = Object.freeze({
  fact: "事实",
  opinion: "看法",
  observation: "观察",
  event: "事件"
});
var SCOPE_LABEL = Object.freeze({
  self: "本体",
  mask: "面具",
  project: "项目"
});
var DEFAULT_MEMORY_ROOT = "D:\\AI_Memory";
function clampIntensity(value) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(MAX_INTENSITY, Math.max(0, num));
}
function emotionCoefficient(intensity) {
  return 1 + clampIntensity(intensity) / 5;
}
function isScope(value) {
  return typeof value === "string" && SCOPES.includes(value);
}

// src/utils/paths.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path = __toESM(require("path"));
var ENV_PATTERN = /%([A-Za-z_][A-Za-z0-9_]*)%/g;
var UNRESOLVED_ENV = /%[^%]+%/;
var EXTENDED_PREFIX = /^\\\\\?\\/;
var DRIVE_LETTER = /^([a-zA-Z]):(?:[\\/]|$)/;
var APP_DATA_SEGMENT = /(^|[\\/])appdata([\\/]|$)/i;
function expandEnvironment(input) {
  return input.replace(ENV_PATTERN, (match, name) => {
    const value = process.env[name];
    return value === void 0 ? match : value;
  });
}
function normalizeMemoryRoot(input) {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new StorageInitError("memoryDbPath 不能为空。", {
      hint: "默认值是 D:\\AI_Memory；请提供一个非 C: 盘的绝对路径。"
    });
  }
  const expanded = expandEnvironment(raw);
  if (UNRESOLVED_ENV.test(expanded)) {
    throw new StorageInitError(`memoryDbPath 含无法解析的环境变量：${raw}`, {
      hint: "请直接写绝对路径，例如 D:\\AI_Memory。"
    });
  }
  const resolved = import_node_path.default.resolve(expanded);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return trimmed || resolved;
}
function assertNotSystemPath(target) {
  const normalized = target.replace(/\//g, "\\");
  const plain = normalized.replace(EXTENDED_PREFIX, "");
  const drive = DRIVE_LETTER.exec(plain);
  if (drive?.[1]?.toUpperCase() === "C") {
    throw new SystemDriveError(target);
  }
  if (APP_DATA_SEGMENT.test(plain)) {
    throw new SystemDriveError(target);
  }
}
function resolveMemoryPaths(memoryDbPath, archiveRoot) {
  const root = normalizeMemoryRoot(memoryDbPath);
  assertNotSystemPath(root);
  const archive = archiveRoot?.trim() ? normalizeMemoryRoot(archiveRoot) : root;
  assertNotSystemPath(archive);
  return {
    root,
    dbFile: import_node_path.default.join(root, "memory.db"),
    archiveRoot: archive,
    modelsDir: import_node_path.default.join(root, ".models"),
    logsDir: import_node_path.default.join(root, "logs")
  };
}
var CANDIDATE_DRIVES = "DEFGHIJKLMNOPQRSTUVWXYZ".split("");
function detectAvailableDrives() {
  return CANDIDATE_DRIVES.filter((letter) => {
    try {
      return import_node_fs.default.existsSync(`${letter}:\\`);
    } catch {
      return false;
    }
  });
}
function isWritableRoot(root) {
  const probe = import_node_path.default.join(root, `.apm-probe-${process.pid}.tmp`);
  try {
    import_node_fs.default.mkdirSync(root, { recursive: true });
    import_node_fs.default.writeFileSync(probe, "ok", "utf8");
    return true;
  } catch {
    return false;
  } finally {
    try {
      import_node_fs.default.rmSync(probe, { force: true });
    } catch {
    }
  }
}
function pickMemoryRoot(preferred) {
  const explicit = (preferred ?? "").trim();
  if (explicit) {
    const driveMatch = DRIVE_LETTER.exec(explicit.replace(/\//g, "\\"));
    const drive = driveMatch?.[1]?.toUpperCase();
    if (drive === "C") return { root: explicit, source: "configured" };
    if (drive !== void 0) {
      try {
        if (import_node_fs.default.existsSync(`${drive}:\\`)) return { root: explicit, source: "configured" };
      } catch {
      }
    } else {
      return { root: explicit, source: "configured" };
    }
  }
  const drives = detectAvailableDrives();
  for (const letter of drives) {
    const candidate = `${letter}:\\AI_Memory`;
    if (isWritableRoot(candidate)) {
      const choice = { root: candidate, source: "auto" };
      if (explicit) {
        choice.note = `配置的 ${explicit} 所在磁盘不可用，已自动改用 ${candidate}`;
      } else if (candidate.toLowerCase() !== DEFAULT_MEMORY_ROOT_FALLBACK.toLowerCase()) {
        choice.note = `未找到 D 盘，已自动改用 ${candidate}`;
      }
      return choice;
    }
  }
  const noDriveNote = "没有找到任何非系统盘，请把 memoryDbPath 指向一个可用的非 C 盘。";
  return drives.length === 0 ? { root: explicit || DEFAULT_MEMORY_ROOT_FALLBACK, source: "configured", note: noDriveNote } : { root: explicit || DEFAULT_MEMORY_ROOT_FALLBACK, source: "configured" };
}
var DEFAULT_MEMORY_ROOT_FALLBACK = "D:\\AI_Memory";
function ensureMemoryDirectories(paths) {
  const directories = [paths.root, paths.archiveRoot, paths.modelsDir, paths.logsDir];
  for (const dir of directories) {
    try {
      import_node_fs.default.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new StorageInitError(`无法创建记忆目录：${dir}`, {
        cause: error,
        hint: "检查磁盘是否存在、是否只读、是否有权限。"
      });
    }
  }
  const probe = import_node_path.default.join(paths.root, `.apm-write-probe-${process.pid}.tmp`);
  try {
    import_node_fs.default.writeFileSync(probe, "ok", "utf8");
  } catch (error) {
    throw new StorageInitError(`记忆目录不可写：${paths.root}`, {
      cause: error,
      hint: "换一个可写目录，或检查杀毒软件/权限设置。"
    });
  } finally {
    try {
      import_node_fs.default.rmSync(probe, { force: true });
    } catch {
    }
  }
}
function sanitizeSegment(value, fallback = "_") {
  const cleaned = value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+$/, "_").trim();
  const safe = cleaned.slice(0, 64).replace(/[. ]+$/g, "");
  return safe || fallback;
}
function paintRed(text) {
  return `\x1B[31m${text}\x1B[0m`;
}
function printSystemDriveAlert(error) {
  const lines = [
    "",
    "✖ ai-persistent-memory 拒绝启动：记忆库路径不安全",
    `  ${error.message}`,
    ...error.hint ? [`  ${error.hint}`] : [],
    "  已中止：不会创建数据库，也不会悄悄退回到 C 盘。",
    ""
  ];
  process.stderr.write(`${paintRed(lines.join("\n"))}
`);
}

// src/adapters/archive/MarkdownArchive.ts
var NullArchive = class {
  appendMemory(_record) {
  }
  removeMemory(_record) {
  }
};
var MarkdownArchive = class {
  constructor(paths) {
    this.paths = paths;
  }
  paths;
  appendMemory(record) {
    const touched = [];
    try {
      const kindFile = this.kindFileFor(record);
      this.appendBlock(kindFile, this.kindHeader(record), this.renderBlock(record));
      touched.push(kindFile);
      const dailyFile = this.dailyFileFor(record);
      this.appendLine(
        dailyFile,
        `# ${localDate(record.createdAt)} · 每天的流水

> ai-persistent-memory · 人读日志，按写入时间追加。
`,
        `- ${localTime(record.createdAt)} · [${MEMORY_KIND_LABEL[record.kind]}] ${oneLine(record.layers.fact)} <!-- apm:id=${record.id} -->`
      );
      touched.push(dailyFile);
      if (record.layers.intensity >= 6) {
        const emotionFile = this.emotionFile();
        this.appendBlock(
          emotionFile,
          "# 情绪账\n\n> 强度 ≥ 6 的记忆按时间记账；跨线共享（图⑥）。\n",
          [
            `<!-- apm:id=${record.id} -->`,
            `- ${localDateTime(record.createdAt)} · 强度 ${record.layers.intensity.toFixed(1)}/10 · [${MEMORY_KIND_LABEL[record.kind]}] ${oneLine(record.layers.fact)} · 范围：${scopeLabel(record)}`,
            `<!-- /apm:id=${record.id} -->`
          ].join("\n")
        );
        touched.push(emotionFile);
      }
    } catch (error) {
      for (const file of touched) {
        try {
          this.stripFile(file, record.id);
        } catch {
        }
      }
      throw new StorageInitError(
        `Markdown 档案写入失败：${record.id}`,
        {
          cause: error,
          hint: "检查 archiveRoot 所在磁盘的权限与剩余空间。"
        }
      );
    }
  }
  removeMemory(record) {
    this.stripFile(this.kindFileFor(record), record.id);
    this.stripFile(this.dailyFileFor(record), record.id);
    this.stripFile(this.emotionFile(), record.id);
  }
  /* ─────────────────────────── 路径 ─────────────────────────── */
  kindFileFor(record) {
    return import_node_path2.default.join(
      this.scopeDirectory(record),
      `${MEMORY_KIND_LABEL[record.kind]}.md`
    );
  }
  scopeDirectory(record) {
    if (record.scope === "self") {
      return import_node_path2.default.join(this.paths.archiveRoot, "01_记忆");
    }
    const segment = sanitizeSegment(record.scopeRef ?? "unknown");
    const group = record.scope === "mask" ? "面具" : "项目";
    return import_node_path2.default.join(this.paths.archiveRoot, "01_记忆", group, segment);
  }
  dailyFileFor(record) {
    return import_node_path2.default.join(
      this.paths.archiveRoot,
      "02_日记",
      "每天的流水",
      `${localDate(record.createdAt)}.md`
    );
  }
  emotionFile() {
    return import_node_path2.default.join(this.paths.archiveRoot, "01_记忆", "情绪账.md");
  }
  /* ─────────────────────────── 渲染 ─────────────────────────── */
  kindHeader(record) {
    return [
      `# ${MEMORY_KIND_LABEL[record.kind]}`,
      "",
      `> ai-persistent-memory 人读档案 · 范围：${scopeLabel(record)}`,
      "> 原则一：原文不压缩。本文件由 SQLite 索引同步生成。",
      ""
    ].join("\n");
  }
  renderBlock(record) {
    const lines = [
      `<!-- apm:id=${record.id} -->`,
      `## ${localDateTime(record.occurredAt)} · ${MEMORY_KIND_LABEL[record.kind]} · 强度 ${record.layers.intensity.toFixed(1)}/10 · 权重 ${record.weight.toFixed(2)}`,
      "",
      `- **事实**：${oneLine(record.layers.fact)}`
    ];
    if (record.layers.feltThen) lines.push(`- **当时感觉**：${oneLine(record.layers.feltThen)}`);
    if (record.layers.thoughtThen) lines.push(`- **当时在想**：${oneLine(record.layers.thoughtThen)}`);
    if (record.layers.reframe) lines.push(`- **后来再想**：${oneLine(record.layers.reframe)}`);
    if (record.layers.recalledLater) lines.push(`- **回忆补**：${oneLine(record.layers.recalledLater)}`);
    lines.push("- **原文**：");
    for (const rawLine of record.rawText.split(/\r?\n/)) {
      lines.push(`  > ${rawLine}`);
    }
    lines.push(`- **范围**：${scopeLabel(record)}`);
    lines.push(
      `- **标签**：${record.tags.length > 0 ? record.tags.map((tag) => `#${tag}`).join(" ") : "—"}`
    );
    lines.push(`<!-- /apm:id=${record.id} -->`);
    return lines.join("\n");
  }
  /* ─────────────────────────── 文件操作 ─────────────────────────── */
  appendBlock(file, header, block) {
    const existing = this.readIfExists(file) ?? header;
    const stripped = stripId(existing, blockId(block));
    const next = `${stripped.trimEnd()}

${block}
`;
    this.writeAtomic(file, next);
  }
  appendLine(file, header, line) {
    const existing = this.readIfExists(file) ?? header;
    const next = existing.endsWith("\n") ? `${existing}${line}
` : `${existing}
${line}
`;
    this.writeAtomic(file, next);
  }
  stripFile(file, id) {
    const existing = this.readIfExists(file);
    if (existing === null) return;
    const next = stripId(existing, id);
    if (next !== existing) {
      this.writeAtomic(file, next);
    }
  }
  readIfExists(file) {
    try {
      return import_node_fs2.default.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  writeAtomic(file, content) {
    import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${(0, import_node_crypto.randomUUID)()}.tmp`;
    try {
      import_node_fs2.default.writeFileSync(temp, content, "utf8");
      import_node_fs2.default.renameSync(temp, file);
    } catch (error) {
      try {
        import_node_fs2.default.rmSync(temp, { force: true });
      } catch {
      }
      throw error;
    }
  }
};
function blockId(block) {
  const match = /<!-- apm:id=([^\s]+) -->/.exec(block);
  return match?.[1] ?? "";
}
function stripId(content, id) {
  if (!id) return content;
  const start = `<!-- apm:id=${id} -->`;
  const end = `<!-- /apm:id=${id} -->`;
  const kept = [];
  let skipping = false;
  for (const line of content.split("\n")) {
    if (skipping) {
      if (line.includes(end)) skipping = false;
      continue;
    }
    if (line.trim() === start) {
      skipping = true;
      continue;
    }
    if (line.includes(`apm:id=${id}`)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}
function scopeLabel(record) {
  const base = SCOPE_LABEL[record.scope];
  return record.scopeRef ? `${base}/${record.scopeRef}` : base;
}
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function purgeArchiveMarkdown(archiveRoot) {
  let changed = 0;
  for (const file of listMarkdownFiles(archiveRoot)) {
    let content;
    try {
      content = import_node_fs2.default.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!content.includes("apm:id=")) continue;
    const kept = [];
    let skipping = false;
    for (const line of content.split("\n")) {
      if (skipping) {
        if (line.includes("<!-- /apm:id=")) skipping = false;
        continue;
      }
      if (/^\s*<!-- apm:id=[^\s]+ -->\s*$/.test(line)) {
        skipping = true;
        continue;
      }
      if (line.includes("apm:id=")) continue;
      kept.push(line);
    }
    const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    if (next === content) continue;
    const temp = `${file}.${process.pid}.${(0, import_node_crypto.randomUUID)()}.tmp`;
    try {
      import_node_fs2.default.writeFileSync(temp, next, "utf8");
      import_node_fs2.default.renameSync(temp, file);
      changed += 1;
    } catch {
      try {
        import_node_fs2.default.rmSync(temp, { force: true });
      } catch {
      }
    }
  }
  return changed;
}
function listMarkdownFiles(root) {
  const files = [];
  const stack = [root];
  const skip = /* @__PURE__ */ new Set(["backups", ".models", "logs"]);
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === void 0) continue;
    let entries;
    try {
      entries = import_node_fs2.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = import_node_path2.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name.toLowerCase())) continue;
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(full);
    }
  }
  return files;
}
function localDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function localTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(11, 16);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function localDateTime(iso) {
  return `${localDate(iso)} ${localTime(iso)}`;
}

// src/adapters/storage/MemoryRepository.ts
var INSERT_MEMORY_SQL = `
INSERT INTO memories (
  id, scope, scope_ref, kind,
  fact, felt_then, intensity, thought_then, reframe, recalled_later,
  raw_text, summary, weight, half_life_days,
  state, state_reason, is_valid, recall_count, review_count,
  content_hash, conversation_id, session_id, turn_id, speaker,
  occurred_at, created_at, updated_at,
  last_recalled_at, last_reviewed_at, sealed_at, cold_at, archived_at
) VALUES (
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?, ?
)`;
var MemoryRepository = class {
  constructor(db) {
    this.db = db;
  }
  db;
  /* ─────────────────────────── 写入 ─────────────────────────── */
  insertMemory(record) {
    this.db.prepare(INSERT_MEMORY_SQL).run(
      record.id,
      record.scope,
      record.scopeRef,
      record.kind,
      record.layers.fact,
      record.layers.feltThen,
      record.layers.intensity,
      record.layers.thoughtThen,
      record.layers.reframe,
      record.layers.recalledLater,
      record.rawText,
      record.summary,
      record.weight,
      record.halfLifeDays,
      record.state,
      record.stateReason,
      record.isValid ? 1 : 0,
      record.recallCount,
      record.reviewCount,
      record.contentHash,
      record.source.conversationId,
      record.source.sessionId,
      record.source.turnId,
      record.source.speaker,
      record.occurredAt,
      record.createdAt,
      record.updatedAt,
      record.lastRecalledAt,
      record.lastReviewedAt,
      record.sealedAt,
      record.coldAt,
      record.archivedAt
    );
  }
  insertTags(memoryId, tags) {
    if (tags.length === 0) return;
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)`
    );
    for (const tag of tags) {
      statement.run(memoryId, tag);
    }
  }
  insertTombstone(tombstone) {
    this.db.prepare(
      `INSERT INTO memory_tombstones
           (id, content_hash, scope, scope_ref, kind, deleted_at, reason, age_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tombstone.id,
      tombstone.contentHash,
      tombstone.scope,
      tombstone.scopeRef,
      tombstone.kind,
      tombstone.deletedAt,
      tombstone.reason,
      tombstone.ageDays
    );
  }
  markCold(memoryId, now, reason) {
    this.db.prepare(
      `UPDATE memories
            SET state = 'cold', cold_at = ?, state_reason = ?, updated_at = ?
          WHERE id = ? AND state = 'active'`
    ).run(now, reason, now, memoryId);
  }
  /* ─────────────────────────── 复习 / 合并 / 任务账本 ─────────────────────────── */
  findReviewCandidates(limit) {
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE state = 'active' AND is_valid = 1
          ORDER BY RANDOM()
          LIMIT ?`
    ).all(limit);
    return this.hydrate(rows);
  }
  applyReview(memoryId, now, weightAfter) {
    this.db.prepare(
      `UPDATE memories
            SET weight = ?,
                review_count = review_count + 1,
                last_reviewed_at = ?,
                updated_at = ?
          WHERE id = ?`
    ).run(weightAfter, now, now, memoryId);
  }
  insertReviewLog(entry) {
    this.db.prepare(
      `INSERT INTO review_log
           (memory_id, reviewed_at, method, weight_before, weight_after, note)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      entry.memoryId,
      entry.reviewedAt,
      entry.method,
      entry.weightBefore,
      entry.weightAfter,
      entry.note
    );
  }
  findDuplicateGroups(limit) {
    const rows = this.db.prepare(
      `SELECT content_hash, scope, ifnull(scope_ref, '') AS scope_ref_key
           FROM memories
          WHERE state = 'active'
          GROUP BY content_hash, scope, ifnull(scope_ref, '')
         HAVING count(*) > 1
          LIMIT ?`
    ).all(limit);
    return rows.map((row) => ({
      contentHash: row.content_hash,
      scope: row.scope,
      scopeRef: row.scope_ref_key === "" ? null : row.scope_ref_key
    }));
  }
  findDuplicatesByHash(scope, scopeRef, contentHash, limit = 10) {
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE state = 'active'
            AND scope = ?
            AND ifnull(scope_ref, '') = ifnull(?, '')
            AND content_hash = ?
          ORDER BY created_at ASC
          LIMIT ?`
    ).all(scope, scopeRef, contentHash, limit);
    return this.hydrate(rows);
  }
  insertMergeLog(entry) {
    this.db.prepare(
      `INSERT INTO merge_log (survivor_id, merged_ids_json, created_at, note)
         VALUES (?, ?, ?, ?)`
    ).run(entry.survivorId, JSON.stringify(entry.mergedIds), entry.createdAt, entry.note);
  }
  /** 幂等占位：UNIQUE(job, scheduled_for) 冲突时返回 false（该档期已经跑过）。 */
  beginMaintenanceRun(run) {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO maintenance_runs
           (id, job, scheduled_for, started_at, status)
         VALUES (?, ?, ?, ?, 'running')`
    ).run(run.id, run.job, run.scheduledFor, run.startedAt);
    return result.changes > 0;
  }
  finishMaintenanceRun(id, status, finishedAt, statsJson, error) {
    this.db.prepare(
      `UPDATE maintenance_runs
            SET status = ?, finished_at = ?, stats_json = ?, error = ?
          WHERE id = ?`
    ).run(status, finishedAt, statsJson, error, id);
  }
  markRecalled(memoryIds, now) {
    if (memoryIds.length === 0) return 0;
    const statement = this.db.prepare(
      `UPDATE memories
          SET recall_count = recall_count + 1,
              last_recalled_at = ?,
              updated_at = ?
        WHERE id = ?`
    );
    let updated = 0;
    for (const id of memoryIds) {
      updated += statement.run(now, now, id).changes;
    }
    return updated;
  }
  deleteMemory(memoryId) {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
  }
  /** 记忆总数（含所有状态）。 */
  countAll() {
    const row = this.db.prepare("SELECT count(*) AS c FROM memories").get();
    return Number(row?.c ?? 0);
  }
  /**
   * 物理清空全部记忆数据（保留 meta 里的设置与 schema 版本）。
   *
   * 顺序：先删关联表（tags / embeddings / links），再删主表，
   * 最后清日志类表，避免留下指向已删记忆的脏数据。
   */
  clearAllMemoryData() {
    const run = this.db.transaction(() => {
      for (const table of [
        "memory_tags",
        "memory_embeddings",
        "memory_links",
        "memories",
        "memory_tombstones",
        "review_log",
        "merge_log",
        "injection_log",
        "maintenance_runs"
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    run();
  }
  /* ─────────────────────────── 读取 ─────────────────────────── */
  getMemory(id) {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
    if (!row) return null;
    return this.mapRow(row, this.loadTags([id]).get(id) ?? []);
  }
  findDedupeCandidates(scope, scopeRef, sinceIso, includeSealed, limit = 20) {
    const stateCondition = includeSealed ? "state IN ('active', 'sealed')" : "state = 'active'";
    const rows = this.db.prepare(
      `SELECT id, raw_text, content_hash
           FROM memories
          WHERE scope = ?
            AND ifnull(scope_ref, '') = ifnull(?, '')
            AND created_at >= ?
            AND ${stateCondition}
          ORDER BY created_at DESC
          LIMIT ?`
    ).all(scope, scopeRef, sinceIso, limit);
    return rows.map((row) => ({
      id: row.id,
      rawText: row.raw_text,
      contentHash: row.content_hash
    }));
  }
  findTombstoneSince(contentHash, sinceIso) {
    const row = this.db.prepare(
      `SELECT id FROM memory_tombstones
          WHERE content_hash = ? AND deleted_at >= ?
          LIMIT 1`
    ).get(contentHash, sinceIso);
    return row?.id ?? null;
  }
  /** 检索候选：状态过滤 + scope 可见性 + 最近更新排序。 */
  findCandidates(scope, scopeRef, includeSealed, limit = 500) {
    const stateClause = includeSealed ? "(state = 'active' OR state = 'sealed')" : "state = 'active'";
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE ${stateClause} AND ${visible.sql}
          ORDER BY updated_at DESC
          LIMIT ?`
    ).all(...visible.params, limit);
    return this.hydrate(rows);
  }
  findByIds(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE id IN (${placeholders}) AND state = 'active'`
    ).all(...ids);
    return this.hydrate(rows);
  }
  /** 生命周期扫描用：全部活跃且有效的记忆（不分线）。 */
  findActive() {
    const rows = this.db.prepare(`SELECT * FROM memories WHERE state = 'active' AND is_valid = 1`).all();
    return this.hydrate(rows);
  }
  findColdBefore(cutoffIso) {
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE state = 'cold' AND cold_at IS NOT NULL AND cold_at <= ?`
    ).all(cutoffIso);
    return this.hydrate(rows);
  }
  findOccurredBetween(startIso, endIso, scope, scopeRef, limit = 5) {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE state = 'active'
            AND occurred_at >= ? AND occurred_at < ?
            AND ${visible.sql}
          ORDER BY occurred_at DESC
          LIMIT ?`
    ).all(startIso, endIso, ...visible.params, limit);
    return this.hydrate(rows);
  }
  findSessionRecent(sessionId, scope, scopeRef, limit = 3) {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE state = 'active' AND session_id = ? AND ${visible.sql}
          ORDER BY created_at DESC
          LIMIT ?`
    ).all(sessionId, ...visible.params, limit);
    return this.hydrate(rows);
  }
  findEmotionalSince(sinceIso, minIntensity, scope, scopeRef, limit = 1) {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db.prepare(
      `SELECT * FROM memories
          WHERE state = 'active'
            AND intensity >= ? AND created_at >= ?
            AND ${visible.sql}
          ORDER BY intensity DESC, created_at DESC
          LIMIT ?`
    ).all(minIntensity, sinceIso, ...visible.params, limit);
    return this.hydrate(rows);
  }
  findByTag(tag, scope, scopeRef, limit = 3) {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db.prepare(
      `SELECT m.* FROM memories m
           JOIN memory_tags t ON t.memory_id = m.id
          WHERE t.tag = ? AND m.state = 'active' AND ${visible.sql}
          ORDER BY m.occurred_at DESC
          LIMIT ?`
    ).all(tag, ...visible.params, limit);
    return this.hydrate(rows);
  }
  loadVectors(ids, model) {
    const result = /* @__PURE__ */ new Map();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT memory_id, vector FROM memory_embeddings
          WHERE model = ? AND memory_id IN (${placeholders})`
    ).all(model, ...ids);
    for (const row of rows) {
      result.set(row.memory_id, decodeVector(row.vector));
    }
    return result;
  }
  countByState() {
    const rows = this.db.prepare(`SELECT state, count(*) AS total FROM memories GROUP BY state`).all();
    const result = {};
    for (const row of rows) {
      result[row.state] = row.total;
    }
    return result;
  }
  /* ─────────────────────────── 内部 ─────────────────────────── */
  visibleClause(scope, scopeRef) {
    if (scope === "self") {
      return { sql: "scope = 'self'", params: [] };
    }
    return {
      sql: "(scope = 'self' OR (scope = ? AND scope_ref = ?))",
      params: [scope, scopeRef ?? ""]
    };
  }
  hydrate(rows) {
    if (rows.length === 0) return [];
    const tags = this.loadTags(rows.map((row) => row.id));
    return rows.map((row) => this.mapRow(row, tags.get(row.id) ?? []));
  }
  loadTags(ids) {
    const result = /* @__PURE__ */ new Map();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT memory_id, tag FROM memory_tags
          WHERE memory_id IN (${placeholders})
          ORDER BY tag`
    ).all(...ids);
    for (const row of rows) {
      const existing = result.get(row.memory_id);
      if (existing) {
        existing.push(row.tag);
      } else {
        result.set(row.memory_id, [row.tag]);
      }
    }
    return result;
  }
  mapRow(row, tags) {
    return {
      id: row.id,
      scope: row.scope,
      scopeRef: row.scope_ref,
      kind: row.kind,
      rawText: row.raw_text,
      layers: {
        fact: row.fact,
        feltThen: row.felt_then,
        intensity: row.intensity,
        thoughtThen: row.thought_then,
        reframe: row.reframe,
        recalledLater: row.recalled_later
      },
      summary: row.summary,
      tags,
      weight: row.weight,
      halfLifeDays: row.half_life_days,
      state: row.state,
      stateReason: row.state_reason,
      isValid: row.is_valid === 1,
      recallCount: row.recall_count,
      reviewCount: row.review_count,
      contentHash: row.content_hash,
      source: {
        conversationId: row.conversation_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        speaker: row.speaker
      },
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRecalledAt: row.last_recalled_at,
      lastReviewedAt: row.last_reviewed_at,
      sealedAt: row.sealed_at,
      coldAt: row.cold_at,
      archivedAt: row.archived_at
    };
  }
};
function decodeVector(blob) {
  const copy = new Uint8Array(blob);
  const length = Math.floor(copy.byteLength / 4);
  const out = new Float32Array(length);
  const view = new DataView(copy.buffer, copy.byteOffset, length * 4);
  for (let i = 0; i < length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

// src/config.ts
var DEFAULT_CONFIG = Object.freeze({
  memoryDbPath: DEFAULT_MEMORY_ROOT,
  archive: Object.freeze({ enabled: true, root: null }),
  // 快照统一放在 <memoryDbPath>\backups\backup-<时间戳>，只保留最近 3 份。
  backup: Object.freeze({ retention: 3 }),
  embedding: Object.freeze({
    enabled: false,
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    cacheDir: null
  }),
  retrieval: Object.freeze({
    topK: 8,
    minScore: 0.05,
    expandHops: 1,
    expandFactor: 0.55,
    maxExpanded: 6,
    budgetTokens: 1200
  }),
  dedupe: Object.freeze({
    windowMs: DEDUPE_WINDOW_MS,
    similarityThreshold: DEDUPE_SIMILARITY_THRESHOLD,
    includeSealed: true
  }),
  lifecycle: Object.freeze({
    coldAfterDays: 90,
    purgeAfterDays: 365,
    coldRetentionThreshold: 0.6,
    sweepIntervalHours: 6
  }),
  llm: Object.freeze({
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    temperature: 0.2,
    timeoutMs: 3e4,
    maxRetries: 2
  })
});
function loadConfig(overrides = {}) {
  const config = {
    memoryDbPath: (overrides.memoryDbPath ?? DEFAULT_CONFIG.memoryDbPath).trim(),
    archive: { ...DEFAULT_CONFIG.archive, ...overrides.archive ?? {} },
    backup: { ...DEFAULT_CONFIG.backup, ...overrides.backup ?? {} },
    embedding: { ...DEFAULT_CONFIG.embedding, ...overrides.embedding ?? {} },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...overrides.retrieval ?? {} },
    dedupe: { ...DEFAULT_CONFIG.dedupe, ...overrides.dedupe ?? {} },
    lifecycle: { ...DEFAULT_CONFIG.lifecycle, ...overrides.lifecycle ?? {} },
    llm: { ...DEFAULT_CONFIG.llm, ...overrides.llm ?? {} }
  };
  if (overrides.logger) {
    config.logger = overrides.logger;
  }
  validateConfig(config);
  return config;
}
function validateConfig(config) {
  if (!config.memoryDbPath) {
    throw new ConfigError("memoryDbPath 不能为空。", {
      hint: `默认值应为 ${DEFAULT_MEMORY_ROOT}。`
    });
  }
  if (config.archive.root !== null && !config.archive.root.trim()) {
    throw new ConfigError("archive.root 只能是 null 或非空路径。");
  }
  assertRange("backup.retention", config.backup.retention, 1, 50, " 份");
  assertRange("embedding.dim", config.embedding.dim, 1, 4096);
  if (config.embedding.enabled && config.embedding.model === EMBEDDING_MODEL && config.embedding.dim !== EMBEDDING_DIM) {
    throw new ConfigError(
      `模型 ${EMBEDDING_MODEL} 固定为 ${EMBEDDING_DIM} 维，当前 embedding.dim=${config.embedding.dim}。`
    );
  }
  assertRange("retrieval.topK", config.retrieval.topK, 1, 50);
  assertRange("retrieval.minScore", config.retrieval.minScore, 0, 1);
  assertRange("retrieval.expandFactor", config.retrieval.expandFactor, 0, 1);
  assertRange("retrieval.maxExpanded", config.retrieval.maxExpanded, 0, 50);
  assertRange("retrieval.budgetTokens", config.retrieval.budgetTokens, 100, 2e4);
  if (config.retrieval.expandHops !== 0 && config.retrieval.expandHops !== 1) {
    throw new ConfigError("retrieval.expandHops 只能是 0 或 1（图③只做一轮扩散）。");
  }
  assertRange("dedupe.windowMs", config.dedupe.windowMs, 6e4, 7 * 24 * 36e5, " 毫秒");
  assertRange("dedupe.similarityThreshold", config.dedupe.similarityThreshold, 0.5, 1);
  assertRange("lifecycle.coldAfterDays", config.lifecycle.coldAfterDays, 1, 3650, " 天");
  assertRange("lifecycle.purgeAfterDays", config.lifecycle.purgeAfterDays, 1, 3650, " 天");
  if (config.lifecycle.purgeAfterDays <= config.lifecycle.coldAfterDays) {
    throw new ConfigError("lifecycle.purgeAfterDays 必须大于 coldAfterDays：先冷存，才可能清理。");
  }
  assertRange("lifecycle.coldRetentionThreshold", config.lifecycle.coldRetentionThreshold, 0, MAX_WEIGHT);
  assertRange("lifecycle.sweepIntervalHours", config.lifecycle.sweepIntervalHours, 1, 168, " 小时");
  assertRange("llm.temperature", config.llm.temperature, 0, 2);
  assertRange("llm.timeoutMs", config.llm.timeoutMs, 1e3, 3e5, " 毫秒");
  assertRange("llm.maxRetries", config.llm.maxRetries, 0, 5);
  if (!config.llm.apiKeyEnv.trim()) {
    throw new ConfigError("llm.apiKeyEnv 不能为空：密钥只从环境变量读取。");
  }
  if (config.llm.baseUrl !== null && !/^https?:\/\//i.test(config.llm.baseUrl)) {
    throw new ConfigError(`llm.baseUrl 必须以 http(s):// 开头，当前 ${config.llm.baseUrl}。`);
  }
  if (!["deepseek", "openai-compatible", "mock"].includes(config.llm.provider)) {
    throw new ConfigError(`未知的 llm.provider：${String(config.llm.provider)}`);
  }
}
function assertRange(name, value, min, max, unit = "") {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} 必须在 ${min}-${max}${unit} 之间，当前为 ${String(value)}。`
    );
  }
}

// src/core/decay.ts
var DAY_MS = 864e5;
function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return (to - from) / DAY_MS;
}
function decayAnchor(memory) {
  let anchor = memory.createdAt;
  let anchorMs = Date.parse(anchor);
  for (const candidate of [memory.lastRecalledAt, memory.lastReviewedAt]) {
    if (candidate === null) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms) && ms > anchorMs) {
      anchorMs = ms;
      anchor = candidate;
    }
  }
  return anchor;
}
function retention(ageDays, halfLifeDays) {
  if (!Number.isFinite(ageDays) || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}
function retainedWeight(memory, nowIso) {
  const age = Math.max(0, daysBetween(decayAnchor(memory), nowIso));
  return memory.weight * retention(age, memory.halfLifeDays);
}
function inactiveDays(memory, nowIso) {
  return Math.max(0, daysBetween(decayAnchor(memory), nowIso));
}
function shouldGoCold(memory, nowIso, config) {
  if (memory.state !== "active" || !memory.isValid) return false;
  if (inactiveDays(memory, nowIso) < config.coldAfterDays) return false;
  return retainedWeight(memory, nowIso) < config.coldRetentionThreshold;
}

// src/core/dedupe.ts
var import_node_crypto2 = require("crypto");

// src/core/scoring.ts
var CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
var LATIN_WORD = /[a-z0-9][a-z0-9_+#.-]*/g;
var CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
function normalizeText(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function tokenize(text) {
  const normalized = normalizeText(text);
  const tokens = /* @__PURE__ */ new Set();
  for (const match of normalized.matchAll(LATIN_WORD)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }
  for (const match of normalized.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return [...tokens];
}
function memoryText(memory) {
  return [
    memory.layers.fact,
    memory.layers.feltThen,
    memory.layers.thoughtThen,
    memory.layers.reframe,
    memory.layers.recalledLater,
    memory.rawText,
    memory.summary,
    memory.tags.map((tag) => `#${tag}`).join(" ")
  ].filter((part) => typeof part === "string" && part.length > 0).join(" ");
}
function memoryDigest(memory) {
  const pieces = [`[${MEMORY_KIND_LABEL[memory.kind]}]`, memory.layers.fact];
  if (memory.layers.feltThen) pieces.push(`当时：${memory.layers.feltThen}`);
  if (memory.layers.reframe) pieces.push(`后来：${memory.layers.reframe}`);
  return pieces.join(" ");
}
function scoreMemory(input) {
  const { memory, queryText, queryTokens, now, queryVector, memoryVector } = input;
  const text = memoryText(memory);
  const memoryTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) hits += 1;
  }
  const coverage = queryTokens.size === 0 ? 0 : hits / queryTokens.size;
  const normalizedQuery = normalizeText(queryText);
  const phraseHit = normalizedQuery.length >= 2 && normalizeText(text).includes(normalizedQuery) ? 0.3 : 0;
  let tagHits = 0;
  for (const tag of memory.tags) {
    const normalizedTag = normalizeText(tag);
    if (normalizedTag.length > 0 && normalizedQuery.includes(normalizedTag)) tagHits += 1;
  }
  const tagBonus = Math.min(0.2, tagHits * 0.1);
  let semantic = Math.min(1, coverage * 0.7 + phraseHit + tagBonus);
  let matchedBy = "keyword";
  if (queryVector !== null && memoryVector !== null) {
    const vectorScore = Math.max(0, cosineSimilarity(queryVector, memoryVector));
    if (vectorScore > semantic) {
      semantic = Math.min(1, vectorScore);
      matchedBy = "embedding";
    }
  }
  const decayedWeight = retainedWeight(memory, now);
  const emotion = emotionCoefficient(memory.layers.intensity);
  const score = semantic * decayedWeight * emotion;
  return {
    memory,
    score,
    semantic,
    decayedWeight,
    emotion,
    matchedBy,
    hops: 0
  };
}
function cosineSimilarity(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function estimateTokens(text) {
  let units = 0;
  for (const char of text) {
    units += CJK.test(char) ? 1 : 0.3;
  }
  return Math.ceil(units);
}

// src/core/dedupe.ts
function canonicalText(raw) {
  return normalizeText(raw).replace(/[\s\p{P}\p{S}]+/gu, "");
}
function hashContent(raw) {
  return (0, import_node_crypto2.createHash)("sha256").update(canonicalText(raw), "utf8").digest("hex");
}
function textSimilarity(a, b) {
  const left = canonicalText(a);
  const right = canonicalText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftGrams = shingles(left);
  const rightGrams = shingles(right);
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }
  const total = leftGrams.size + rightGrams.size;
  return total === 0 ? 0 : 2 * intersection / total;
}
function shingles(text) {
  const grams = /* @__PURE__ */ new Set();
  if (text.length === 1) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}
function evaluateDuplicate(input) {
  if (input.tombstoneId !== null) {
    return {
      duplicate: true,
      reason: "tombstone",
      existingId: input.tombstoneId,
      similarity: null
    };
  }
  for (const candidate of input.candidates) {
    if (candidate.contentHash === input.contentHash) {
      return {
        duplicate: true,
        reason: "hash",
        existingId: candidate.id,
        similarity: 1
      };
    }
  }
  let bestId = null;
  let bestSimilarity = 0;
  for (const candidate of input.candidates) {
    const similarity = textSimilarity(input.rawText, candidate.rawText);
    if (similarity >= input.threshold && similarity > bestSimilarity) {
      bestId = candidate.id;
      bestSimilarity = similarity;
    }
  }
  if (bestId !== null) {
    return {
      duplicate: true,
      reason: "similarity",
      existingId: bestId,
      similarity: bestSimilarity
    };
  }
  return { duplicate: false, reason: "none", existingId: null, similarity: null };
}

// src/core/schema.ts
var SCHEMA_VERSION = 1;
var DEFAULT_BUSY_TIMEOUT_MS = 5e3;
var SCHEMA_DDL = String.raw`
-- ────────────────────────────────────────────────────────────────
-- meta：schema 版本、初始化时间等库级元信息（人读 + 迁移辅助）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memories：① 五层字段 + ② 检索属性 + ⑤ 生命周期状态
-- 一条记忆 = 一段原文 + 五层心事 + 可衰减的权重
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT NOT NULL PRIMARY KEY,

  -- ⑥ 分线不分人
  scope            TEXT NOT NULL CHECK (scope IN ('self', 'mask', 'project')),
  scope_ref        TEXT,

  -- ⑤ 半衰期类别
  kind             TEXT NOT NULL CHECK (kind IN ('fact', 'opinion', 'observation', 'event')),

  -- ① 五层：1. 事实（发生了什么）
  fact             TEXT NOT NULL CHECK (length(trim(fact)) > 0),
  -- ① 五层：2. 当时感觉 + 情绪强度 0-10
  felt_then        TEXT,
  intensity        REAL NOT NULL DEFAULT 0 CHECK (intensity >= 0 AND intensity <= 10),
  -- ① 五层：3. 当时在想（哪根情绪线被碰到了）
  thought_then     TEXT,
  -- ① 五层：4. 后来再想（现在怎么看）
  reframe          TEXT,
  -- ① 五层：5. 回忆补（后来才想起来的）
  recalled_later   TEXT,

  -- 原则一：原文不压缩。人读档案与「连续感」都依赖它。
  raw_text         TEXT NOT NULL CHECK (length(trim(raw_text)) > 0),
  -- 机器摘要：只参与排序，可空，永不覆盖 raw_text。
  summary          TEXT,

  -- ③ 打分：权重（基础值）× 半衰期衰减 × 情绪系数
  weight           REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 3.0),
  half_life_days   INTEGER NOT NULL CHECK (half_life_days IN (30, 45, 60, 90)),

  -- ⑤ 五级生命周期：active 活跃 / sealed 封存 / cold 冷存 / archived 归档（永不物理删除）
  state            TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active', 'sealed', 'cold', 'archived')),
  state_reason     TEXT,
  -- 封存：出现矛盾 → 旧条失效但不删（图⑤）
  is_valid         INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),

  recall_count     INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  review_count     INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),

  -- 6 小时防重与合并去重使用的内容指纹（归一化原文的 sha256）
  content_hash     TEXT NOT NULL,

  -- 溯源：哪一轮对话、谁说、事件何时发生
  conversation_id  TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  speaker          TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'system')),

  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_recalled_at TEXT,
  last_reviewed_at TEXT,
  sealed_at        TEXT,
  cold_at          TEXT,
  archived_at      TEXT,

  -- self 不允许带线标识；mask / project 必须带非空线标识
  CHECK (
    (scope = 'self' AND scope_ref IS NULL)
    OR (scope IN ('mask', 'project') AND scope_ref IS NOT NULL AND length(trim(scope_ref)) > 0)
  )
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_tags：标签表（图②「同标签互链」靠它，而不是 JSON 字段）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL CHECK (length(trim(tag)) > 0),
  PRIMARY KEY (memory_id, tag)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_links：语义近邻 + 同标签 + 手动连线（图③「一轮扩散」的边）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_links (
  from_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('semantic', 'tag', 'manual')),
  strength   REAL NOT NULL DEFAULT 1.0 CHECK (strength >= 0 AND strength <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_embeddings：bge-small-zh-v1.5 的 512 维 Float32 BLOB
-- 与 memories 分表：模型可换、可重建，不影响业务字段
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL CHECK (dim > 0),
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, model)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_tombstones：物理删除后的墓碑，只留指纹，不留正文
-- 用途：防止「刚清理完又被同一段话写回来」，以及审计清理行为
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_tombstones (
  id           TEXT NOT NULL PRIMARY KEY,
  content_hash TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('self', 'mask', 'project')),
  scope_ref    TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('fact', 'opinion', 'observation', 'event')),
  deleted_at   TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('lifecycle_purge', 'manual_forget', 'manual_purge')),
  age_days     INTEGER NOT NULL CHECK (age_days >= 0)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- review_log：图④ 复习记录（00:00 三条复述、数字核对 ×1.6）
-- 故意不建外键：记忆被物理删除后，复习历史仍要保留
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  reviewed_at   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('nightly_recall', 'number_check', 'manual')),
  weight_before REAL NOT NULL,
  weight_after  REAL NOT NULL,
  note          TEXT
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- merge_log：图④ 23:00 合并重复、旧事实归档的账本
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merge_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  survivor_id     TEXT NOT NULL,
  merged_ids_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  note            TEXT
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- maintenance_runs：定时任务账本
-- UNIQUE(job, scheduled_for) 同时提供幂等与「睡眠错过补跑」能力
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id            TEXT NOT NULL PRIMARY KEY,
  job           TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  stats_json    TEXT,
  error         TEXT,
  UNIQUE (job, scheduled_for)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- injection_log：每轮注入了哪些记忆、估算 token（调预算与复盘用）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS injection_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  memory_ids_json TEXT NOT NULL,
  token_estimate  INTEGER NOT NULL CHECK (token_estimate >= 0),
  created_at      TEXT NOT NULL
) STRICT;

-- ─────────────────────────── 索引 ───────────────────────────
-- 检索入口：scope + 生命状态
CREATE INDEX IF NOT EXISTS ix_memories_scope
  ON memories(scope, scope_ref, state);
-- 6 小时防重：按指纹取最近窗口
CREATE INDEX IF NOT EXISTS ix_memories_hash
  ON memories(content_hash, created_at);
-- 冷存扫描：90 天没被想起
CREATE INDEX IF NOT EXISTS ix_memories_state_recalled
  ON memories(state, last_recalled_at);
-- 通用时间序（日记 / 周记 / 星图）
CREATE INDEX IF NOT EXISTS ix_memories_state_created
  ON memories(state, created_at);
CREATE INDEX IF NOT EXISTS ix_memories_occurred
  ON memories(occurred_at);
-- 类别统计与半衰期调参
CREATE INDEX IF NOT EXISTS ix_memories_kind_state
  ON memories(kind, state);
-- 清理扫描只关心冷存行
CREATE INDEX IF NOT EXISTS ix_memories_cold
  ON memories(cold_at) WHERE state = 'cold';
-- 同标签互链
CREATE INDEX IF NOT EXISTS ix_memory_tags_tag
  ON memory_tags(tag, memory_id);
-- 反向遍历链接（被谁指向）
CREATE INDEX IF NOT EXISTS ix_memory_links_to
  ON memory_links(to_id, kind);
CREATE INDEX IF NOT EXISTS ix_review_log_memory
  ON review_log(memory_id, reviewed_at);
CREATE INDEX IF NOT EXISTS ix_injection_log_session
  ON injection_log(session_id, created_at);
`;
var EXPECTED_TABLES = Object.freeze([
  "meta",
  "memories",
  "memory_tags",
  "memory_links",
  "memory_embeddings",
  "memory_tombstones",
  "review_log",
  "merge_log",
  "maintenance_runs",
  "injection_log"
]);
function applyPragmas(db, settings = {}) {
  const busyTimeoutMs = Math.max(
    1e3,
    Math.trunc(settings.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)
  );
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  const journalMode = String(db.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
  if (journalMode !== "wal") {
    throw new StorageInitError(
      `记忆库无法启用 WAL（实际 journal_mode="${journalMode}"）。`,
      {
        hint: "并发安全依赖 WAL。请把 memoryDbPath 指向本地 NTFS 盘（例如 D:\\AI_Memory），不要使用网络盘、FAT32 或只读挂载。"
      }
    );
  }
  db.pragma(`synchronous = ${settings.synchronous ?? "NORMAL"}`);
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma(`cache_size = -${Math.max(2e3, settings.cacheSizeKib ?? 16384)}`);
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("journal_size_limit = 67108864");
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  if (!foreignKeys) {
    throw new StorageInitError("foreign_keys 无法开启，级联删除与引用完整性不可用。");
  }
  return {
    journalMode,
    busyTimeoutMs: Number(db.pragma("busy_timeout", { simple: true })),
    synchronous: Number(db.pragma("synchronous", { simple: true })),
    foreignKeys
  };
}
var MIGRATIONS = [
  // 示例（v2）：
  // { version: 2, sql: `ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;` },
];
function initializeSchema(db, options = {}) {
  const pragmas = applyPragmas(db, options);
  const existing = readSchemaVersion(db);
  if (existing > SCHEMA_VERSION) {
    throw new SchemaVersionError(existing, SCHEMA_VERSION);
  }
  const fresh = existing === 0;
  if (fresh) {
    runImmediate(db, () => db.exec(SCHEMA_DDL));
  }
  for (const migration of MIGRATIONS) {
    if (migration.version > existing && migration.version <= SCHEMA_VERSION) {
      runImmediate(db, () => db.exec(migration.sql));
    }
  }
  const tables = listAppTables(db);
  const missing = EXPECTED_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new StorageInitError(
      `记忆库缺少必需的表：${missing.join(", ")}（user_version=${existing}）。`,
      {
        hint: "数据库可能被手工改动或磁盘写坏。请先备份 memory.db，再重命名后重新初始化，或运行 doctor 检查。"
      }
    );
  }
  const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
  runImmediate(db, () => {
    const upsertMeta = db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    const insertMeta = db.prepare(
      `INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES (?, ?, ?)`
    );
    upsertMeta.run("schema_version", String(SCHEMA_VERSION), now);
    upsertMeta.run("last_opened_at", now, now);
    insertMeta.run("bootstrapped_at", now, now);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  if (readSchemaVersion(db) !== SCHEMA_VERSION) {
    throw new StorageInitError("schema 版本写入失败，数据库可能处于只读状态。");
  }
  return { version: SCHEMA_VERSION, fresh, pragmas, tables };
}
function readSchemaVersion(db) {
  const raw = Number(db.pragma("user_version", { simple: true }));
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}
function listAppTables(db) {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`
  ).all();
  return rows.map((row) => row.name);
}
function runImmediate(db, work) {
  const transaction = db.transaction(work);
  transaction.immediate();
}

// src/core/MemoryEngine.ts
var SYSTEM_CLOCK = { now: () => /* @__PURE__ */ new Date() };
var SILENT_LOGGER = {
  debug: () => void 0,
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0
};
var requireFromHere = (0, import_node_module.createRequire)(APM_IMPORT_META_URL);
function openSqliteDatabase(file) {
  const Constructor = requireFromHere("better-sqlite3");
  return new Constructor(file);
}
var MemoryEngine = class {
  config;
  paths;
  clock;
  db;
  repo;
  archive;
  logger;
  embedder;
  ownsDb;
  closed = false;
  constructor(options = {}) {
    this.config = options.config ?? loadConfig(options.overrides ?? {});
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? this.config.logger ?? SILENT_LOGGER;
    this.embedder = options.embedder ?? null;
    try {
      this.paths = resolveMemoryPaths(this.config.memoryDbPath, this.config.archive.root);
    } catch (error) {
      if (error instanceof SystemDriveError) {
        printSystemDriveAlert(error);
      }
      throw error;
    }
    ensureMemoryDirectories(this.paths);
    const ownsDb = options.db === void 0;
    this.ownsDb = ownsDb;
    this.db = options.db ?? (options.openDatabase ?? openSqliteDatabase)(this.paths.dbFile);
    try {
      initializeSchema(this.db, { now: this.nowIso() });
      this.repo = new MemoryRepository(this.db);
      this.archive = options.archive ?? (this.config.archive.enabled ? new MarkdownArchive(this.paths) : new NullArchive());
    } catch (error) {
      if (ownsDb) {
        try {
          this.db.close();
        } catch {
        }
      }
      throw error;
    }
    this.logger.info("记忆引擎已就绪", {
      dbFile: this.paths.dbFile,
      archiveRoot: this.paths.archiveRoot
    });
  }
  /* ══════════════════════════ ① 写进去 ══════════════════════════ */
  /**
   * 写入一条记忆。
   *
   * 防重查询、INSERT、标签写入、Markdown 档案追加全部在同一个
   * BEGIN IMMEDIATE 事务内；任一步抛错都会回滚数据库，档案由 MarkdownArchive
   * 自行回滚已写入的片段。
   */
  async saveMemory(draft) {
    const now = this.nowIso();
    const record = this.prepareRecord(draft, now);
    return this.immediate(() => {
      const dedupe = this.findDuplicate(record, now);
      if (dedupe.duplicate) {
        this.logger.info("6 小时防重命中，跳过写入", {
          existingId: dedupe.existingId,
          reason: dedupe.reason,
          similarity: dedupe.similarity
        });
        return { saved: false, record: null, dedupe };
      }
      this.repo.insertMemory(record);
      this.repo.insertTags(record.id, record.tags);
      this.archive.appendMemory(record);
      this.logger.info("记忆已写入", {
        id: record.id,
        scope: record.scope,
        kind: record.kind,
        intensity: record.layers.intensity
      });
      return { saved: true, record, dedupe };
    });
  }
  prepareRecord(draft, now) {
    const rawText = draft.rawText.trim();
    if (rawText.length === 0) {
      throw new InvalidMemoryError("rawText 不能为空：原文是连续感的根，必须保存。");
    }
    if (draft.scope === "self" && draft.scopeRef !== null) {
      throw new InvalidMemoryError("scope=self 不允许提供 scopeRef。");
    }
    const scopeRef = draft.scope === "self" ? null : (draft.scopeRef ?? "").trim();
    if (draft.scope !== "self" && scopeRef === "") {
      throw new InvalidMemoryError(`${draft.scope} 必须提供非空 scopeRef（uid / slug）。`);
    }
    const fact = draft.layers.fact.trim();
    if (fact.length === 0) {
      throw new InvalidMemoryError("五层第 1 层 fact 不能为空。");
    }
    return {
      id: (0, import_node_crypto3.randomUUID)(),
      scope: draft.scope,
      scopeRef,
      kind: draft.kind,
      rawText,
      layers: {
        fact,
        feltThen: nullable(draft.layers.feltThen),
        intensity: clampIntensity(draft.layers.intensity),
        thoughtThen: nullable(draft.layers.thoughtThen),
        reframe: nullable(draft.layers.reframe),
        recalledLater: nullable(draft.layers.recalledLater)
      },
      summary: nullable(draft.summary ?? null),
      tags: normalizeTags(draft.tags ?? []),
      weight: clampWeight(draft.weight),
      halfLifeDays: HALF_LIFE_DAYS[draft.kind],
      state: "active",
      stateReason: null,
      isValid: true,
      recallCount: 0,
      reviewCount: 0,
      contentHash: hashContent(rawText),
      source: {
        conversationId: draft.source.conversationId,
        sessionId: draft.source.sessionId,
        turnId: draft.source.turnId,
        speaker: draft.source.speaker
      },
      occurredAt: normalizeIso(draft.occurredAt, now),
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
      lastReviewedAt: null,
      sealedAt: null,
      coldAt: null,
      archivedAt: null
    };
  }
  findDuplicate(record, now) {
    const windowStart = new Date(
      Date.parse(now) - this.config.dedupe.windowMs
    ).toISOString();
    const candidates = this.repo.findDedupeCandidates(
      record.scope,
      record.scopeRef,
      windowStart,
      this.config.dedupe.includeSealed
    );
    const tombstoneId = this.repo.findTombstoneSince(record.contentHash, windowStart);
    return evaluateDuplicate({
      rawText: record.rawText,
      contentHash: record.contentHash,
      candidates,
      tombstoneId,
      threshold: this.config.dedupe.similarityThreshold
    });
  }
  /* ══════════════════════════ ③ 用起来 ══════════════════════════ */
  /**
   * 注入成功后由 injector 调用：被想起次数 +1，并刷新半衰期起点。
   * 刻意不放进 recall()：检索结果可能被预算丢弃或上游取消，不能平白续命。
   */
  async markRecalled(memoryIds, nowInput) {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return 0;
    const now = nowInput ?? this.nowIso();
    return this.immediate(() => this.repo.markRecalled(ids, now));
  }
  /**
   * 检索并装配。items 已按预算整块装入（放不下整条跳过，不截断）。
   */
  async recall(query) {
    const startedAt = Date.now();
    const now = query.now ?? this.nowIso();
    const text = (query.text ?? "").trim();
    if (!isScope(query.scope)) {
      throw new InvalidMemoryError(`非法 scope：${String(query.scope)}`);
    }
    const scopeRef = query.scope === "self" ? null : (query.scopeRef ?? "").trim();
    if (query.scope !== "self" && scopeRef === "") {
      throw new InvalidMemoryError(`${query.scope} 检索必须提供 scopeRef。`);
    }
    const queryTokens = new Set(tokenize(text));
    const embedder = this.embedder;
    const queryVector = embedder !== null && text.length > 0 ? await embedder.embed(text) : null;
    const candidates = this.read(
      () => this.repo.findCandidates(query.scope, scopeRef, query.includeSealed === true)
    );
    const vectors = queryVector !== null && embedder !== null ? this.read(
      () => this.repo.loadVectors(
        candidates.map((memory) => memory.id),
        embedder.model
      )
    ) : /* @__PURE__ */ new Map();
    const minScore = query.minScore === void 0 ? this.config.retrieval.minScore : Math.max(0, Math.min(1, query.minScore));
    const scored = [];
    for (const memory of candidates) {
      const item = scoreMemory({
        memory,
        queryText: text,
        queryTokens,
        now,
        queryVector,
        memoryVector: vectors.get(memory.id) ?? null
      });
      if (item.semantic <= 0 || item.score < minScore) continue;
      scored.push(item);
    }
    scored.sort((left, right) => right.score - left.score);
    const topK = clampInt(query.topK ?? this.config.retrieval.topK, 1, 50);
    const top = scored.slice(0, topK);
    const expanded = this.expand(top, query.scope, scopeRef, queryTokens, text, now);
    const tagExpanded = this.expandByTag(top, query.scope, scopeRef, now, minScore);
    const merged = this.mergeScored([...top, ...expanded, ...tagExpanded]).sort(
      (left, right) => right.score - left.score
    );
    const budget = clampInt(
      query.budgetTokens ?? this.config.retrieval.budgetTokens,
      50,
      5e4
    );
    let estimatedTokens = 0;
    let skippedForBudget = 0;
    const items = [];
    for (const item of merged) {
      const cost = estimateTokens(memoryDigest(item.memory)) + 8;
      if (estimatedTokens + cost > budget) {
        skippedForBudget += 1;
        continue;
      }
      items.push(item);
      estimatedTokens += cost;
    }
    return {
      query: text,
      scope: query.scope,
      scopeRef,
      items,
      candidates: candidates.length,
      elapsedMs: Date.now() - startedAt,
      estimatedTokens,
      skippedForBudget
    };
  }
  /**
   * 图③「一轮扩散」：顺着互链把相关旧事带出来。
   * 传播分 = 父项分数 × 边强度 × expandFactor，只扩散一层。
   */
  expand(top, scope, scopeRef, queryTokens, queryText, now) {
    const { expandHops, expandFactor, maxExpanded } = this.config.retrieval;
    if (expandHops === 0 || maxExpanded === 0 || top.length === 0) return [];
    const parentById = new Map(top.map((item) => [item.memory.id, item]));
    const sourceIds = [...parentById.keys()];
    const placeholders = sourceIds.map(() => "?").join(", ");
    const links = this.read(
      () => this.db.prepare(
        `SELECT from_id, to_id, strength FROM memory_links
              WHERE from_id IN (${placeholders})
              ORDER BY strength DESC
              LIMIT 40`
      ).all(...sourceIds)
    );
    const linkByTarget = /* @__PURE__ */ new Map();
    for (const link of links) {
      if (parentById.has(link.to_id)) continue;
      if (!linkByTarget.has(link.to_id)) {
        linkByTarget.set(link.to_id, { fromId: link.from_id, strength: link.strength });
      }
    }
    const targets = [...linkByTarget.keys()];
    if (targets.length === 0) return [];
    const targetRecords = this.read(() => this.repo.findByIds(targets));
    const expanded = [];
    for (const memory of targetRecords) {
      if (!this.isVisible(memory, scope, scopeRef)) continue;
      const link = linkByTarget.get(memory.id);
      if (!link) continue;
      const parent = parentById.get(link.fromId);
      if (!parent) continue;
      const own = scoreMemory({
        memory,
        queryText,
        queryTokens,
        now,
        queryVector: null,
        memoryVector: null
      });
      const propagated = parent.score * link.strength * expandFactor;
      const score = Math.max(own.score, propagated);
      if (score < this.config.retrieval.minScore) continue;
      expanded.push({
        memory,
        score,
        semantic: Math.max(own.semantic, Math.min(1, parent.semantic * link.strength)),
        decayedWeight: own.decayedWeight,
        emotion: own.emotion,
        matchedBy: "link",
        hops: 1
      });
    }
    expanded.sort((left, right) => right.score - left.score);
    return expanded.slice(0, maxExpanded);
  }
  /**
   * 图③「一轮扩散」的 tag 版。
   *
   * 互链（memory_links）平时很稀疏，光靠它「一轮扩散」基本不会触发。
   * 这里补一条更稳的路径：命中高权重记忆后，用它身上的标签顺藤摸瓜
   * 捞出最多 2 条旧事，传播分 = 父项分数 × expandFactor。
   */
  expandByTag(top, scope, scopeRef, now, minScore) {
    const { expandHops, expandFactor, maxExpanded } = this.config.retrieval;
    const best = top[0];
    if (expandHops === 0 || maxExpanded === 0 || best === void 0) return [];
    if (best.score < 1) return [];
    const limit = Math.min(2, maxExpanded);
    const seen = new Set(top.map((item) => item.memory.id));
    const result = [];
    for (const parent of top) {
      if (result.length >= limit) break;
      for (const tag of parent.memory.tags) {
        if (result.length >= limit) break;
        const rows = this.read(() => this.repo.findByTag(tag, scope, scopeRef, 3));
        for (const memory of rows) {
          if (result.length >= limit) break;
          if (seen.has(memory.id)) continue;
          if (!this.isVisible(memory, scope, scopeRef)) continue;
          seen.add(memory.id);
          const own = scoreMemory({
            memory,
            queryText: "",
            queryTokens: /* @__PURE__ */ new Set(),
            now,
            queryVector: null,
            memoryVector: null
          });
          const score = Math.max(own.score, parent.score * expandFactor);
          if (score < minScore) continue;
          result.push({
            memory,
            score,
            semantic: Math.max(own.semantic, 0.5),
            decayedWeight: own.decayedWeight,
            emotion: own.emotion,
            matchedBy: "tag",
            hops: 1
          });
        }
      }
    }
    result.sort((left, right) => right.score - left.score);
    return result;
  }
  isVisible(memory, scope, scopeRef) {
    if (memory.scope === "self") return true;
    return memory.scope === scope && (memory.scopeRef ?? "") === (scopeRef ?? "");
  }
  mergeScored(items) {
    const byId = /* @__PURE__ */ new Map();
    for (const item of items) {
      const existing = byId.get(item.memory.id);
      if (!existing || item.score > existing.score) {
        byId.set(item.memory.id, item);
      }
    }
    return [...byId.values()];
  }
  /* ══════════════════════════ ⑤ 允许忘 ══════════════════════════ */
  /**
   * 物理清空：先清 Markdown 明文，再删库。
   *
   * 顺序很重要——档案删除失败时数据库还完整，用户至少能看到「清空失败」；
   * 反过来就会出现「库里没了、md 里还能看到明文」的假删除隐私事故。
   *
   * 档案只清带 `apm:id=` 标记的插件内容，绝不批量删除用户自建 .md。
   */
  purgeAllData() {
    const purgedArchiveFiles = purgeArchiveMarkdown(this.paths.archiveRoot);
    const deletedRows = this.repo.countAll();
    this.repo.clearAllMemoryData();
    return { deletedRows, purgedArchiveFiles };
  }
  /**
   * 生命周期扫描：活跃 → 冷存 → 物理删除（写墓碑）。
   * 全部在一个 BEGIN IMMEDIATE 事务内完成。
   */
  async sweepLifecycle(nowInput) {
    const now = nowInput ?? this.nowIso();
    return this.immediate(() => {
      const active = this.repo.findActive();
      const markedCold = [];
      for (const memory of active) {
        if (!shouldGoCold(memory, now, this.config.lifecycle)) continue;
        const weight = retainedWeight(memory, now);
        const idle = inactiveDays(memory, now);
        const reason = `冷存：${idle.toFixed(0)} 天未被想起，衰减权重 ${weight.toFixed(2)} < ${this.config.lifecycle.coldRetentionThreshold}`;
        this.repo.markCold(memory.id, now, reason);
        markedCold.push({ memoryId: memory.id, from: "active", to: "cold", reason, at: now });
      }
      const cutoff = new Date(
        Date.parse(now) - this.config.lifecycle.purgeAfterDays * DAY_MS
      ).toISOString();
      const cold = this.repo.findColdBefore(cutoff);
      const purged = [];
      for (const memory of cold) {
        const ageDays = Math.max(
          0,
          Math.floor((Date.parse(now) - Date.parse(memory.createdAt)) / DAY_MS)
        );
        this.repo.insertTombstone({
          id: memory.id,
          contentHash: memory.contentHash,
          scope: memory.scope,
          scopeRef: memory.scopeRef,
          kind: memory.kind,
          deletedAt: now,
          reason: "lifecycle_purge",
          ageDays
        });
        this.archive.removeMemory(memory);
        this.repo.deleteMemory(memory.id);
        purged.push({
          memoryId: memory.id,
          from: "cold",
          to: "deleted",
          reason: `冷存满 ${this.config.lifecycle.purgeAfterDays} 天，物理删除`,
          at: now
        });
      }
      this.logger.info("生命周期扫描完成", {
        scanned: active.length,
        markedCold: markedCold.length,
        purged: purged.length
      });
      return { now, scanned: active.length, markedCold, purged };
    });
  }
  /* ══════════════════════════ ④ 自己维护 ══════════════════════════ */
  /**
   * 图④「00:00 复习 3 条」的默认实现：数字核对 ×1.6。
   * 「用自己的话复述」交给上层 LLM 回调；这里只负责权重与账本，保证可复算。
   */
  async reviewMemories(limit = 3, nowInput) {
    const now = nowInput ?? this.nowIso();
    return this.immediate(() => {
      const candidates = this.repo.findReviewCandidates(clampInt(limit, 1, 10));
      const reviews = [];
      for (const memory of candidates) {
        const weightBefore = memory.weight;
        const weightAfter = Math.min(MAX_WEIGHT, weightBefore * 1.6);
        this.repo.applyReview(memory.id, now, weightAfter);
        this.repo.insertReviewLog({
          memoryId: memory.id,
          reviewedAt: now,
          method: "number_check",
          weightBefore,
          weightAfter,
          note: "nightly review ×1.6"
        });
        reviews.push({ memoryId: memory.id, weightBefore, weightAfter });
      }
      return reviews;
    });
  }
  /**
   * 图④「23:00 合并重复」的保守实现：只合并 content_hash 完全相同的活跃记忆
   * （同 scope / 同 scope_ref），保留最早一条，标签并集后删除其余。
   * 语义改写级合并需要 LLM，交给维护任务的注入回调。
   */
  async mergeExactDuplicates(limit = 20) {
    const now = this.nowIso();
    return this.immediate(() => {
      const groups = this.repo.findDuplicateGroups(clampInt(limit, 1, 100));
      let merged = 0;
      for (const group of groups) {
        const records = this.repo.findDuplicatesByHash(
          group.scope,
          group.scopeRef,
          group.contentHash
        );
        if (records.length < 2) continue;
        const survivor = records[0];
        if (!survivor) continue;
        const mergedIds = [];
        for (const duplicate of records.slice(1)) {
          this.repo.insertTags(survivor.id, duplicate.tags);
          this.repo.deleteMemory(duplicate.id);
          mergedIds.push(duplicate.id);
          merged += 1;
        }
        if (mergedIds.length > 0) {
          this.repo.insertMergeLog({
            survivorId: survivor.id,
            mergedIds,
            createdAt: now,
            note: "exact content_hash merge"
          });
        }
      }
      return { groups: groups.length, merged };
    });
  }
  /* ══════════════════════════ 基础设施 ══════════════════════════ */
  getMemory(id) {
    return this.read(() => this.repo.getMemory(id));
  }
  /** 供 WorldContextBuilder / CLI 等只读消费，写入仍必须走引擎方法。 */
  get repository() {
    return this.repo;
  }
  /** 各生命状态的条数，CLI / doctor 用。 */
  stats() {
    return this.read(() => this.repo.countByState());
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }
  nowIso() {
    return this.clock.now().toISOString();
  }
  /** 写事务：BEGIN IMMEDIATE，先拿写锁再检查，避免并发下双写同一条。 */
  immediate(work) {
    const transaction = this.db.transaction(work);
    return transaction.immediate();
  }
  /** 读事务：deferred 快照，不阻塞别的进程写入。 */
  read(work) {
    const transaction = this.db.transaction(work);
    return transaction.deferred();
  }
};
function nullable(value) {
  if (value === null || value === void 0) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function normalizeIso(value, fallback) {
  if (value === void 0) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}
function clampWeight(value) {
  if (value === void 0 || !Number.isFinite(value)) return 1;
  return Math.min(MAX_WEIGHT, Math.max(0.05, value));
}
function normalizeTags(tags) {
  const unique = /* @__PURE__ */ new Set();
  for (const tag of tags) {
    const normalized = tag.trim().replace(/^#+/, "").trim();
    if (normalized.length === 0 || normalized.length > 32) continue;
    unique.add(normalized);
    if (unique.size >= 8) break;
  }
  return [...unique];
}
function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// src/adapters/storage/NodeSqliteAdapter.ts
var import_node_module2 = require("module");
var requireFromHere2 = (0, import_node_module2.createRequire)(APM_IMPORT_META_URL);
function hasNodeSqlite() {
  try {
    requireFromHere2("node:sqlite");
    return true;
  } catch {
    return false;
  }
}
function openNodeSqliteDatabase(file) {
  const sqlite = requireFromHere2("node:sqlite");
  return new NodeSqliteCompat(new sqlite.DatabaseSync(file));
}
var NodeSqliteCompat = class {
  constructor(db) {
    this.db = db;
  }
  db;
  pragma(source, options) {
    if (options?.simple === true) {
      const row = this.db.prepare(`PRAGMA ${source}`).get();
      return row === void 0 ? void 0 : Object.values(row)[0];
    }
    this.db.exec(`PRAGMA ${source}`);
    return void 0;
  }
  exec(sql) {
    this.db.exec(sql);
    return this;
  }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      run: (...params) => {
        const result = statement.run(...params);
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0)
        };
      },
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params)
    };
  }
  transaction(fn) {
    const deferred = (...args) => this.runTransaction("DEFERRED", fn, args);
    const immediate = (...args) => this.runTransaction("IMMEDIATE", fn, args);
    const exclusive = (...args) => this.runTransaction("EXCLUSIVE", fn, args);
    return Object.assign(deferred, { deferred, immediate, exclusive });
  }
  close() {
    this.db.close();
  }
  runTransaction(mode, fn, args) {
    this.db.exec(`BEGIN ${mode}`);
    try {
      const result = fn(...args);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
};

// src/cli/cli.ts
var HELP = `ai-persistent-memory · 本地长效记忆

用法：
  ai-memory init  [--path D:\\AI_Memory]    初始化数据库与目录
  ai-memory stats [--path D:\\AI_Memory]    查看记忆条数与磁盘占用

说明：
  --path 省略时使用默认 D:\\AI_Memory；
  以 C: 开头或包含 AppData 的路径会被拒绝（SystemDriveError）。
`;
function parseArgs(argv) {
  const positional = [];
  let dbPath = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === void 0) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--path" || arg === "--db") {
      const value = argv[i + 1];
      if (value === void 0 || value === "") {
        throw new Error(`${arg} 需要一个目录路径`);
      }
      dbPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--path=")) {
      dbPath = arg.slice("--path=".length);
      continue;
    }
    if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`未知参数：${arg}`);
    }
    positional.push(arg);
  }
  return {
    command: positional[0] ?? "help",
    dbPath,
    help
  };
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function countMarkdown(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === void 0) continue;
    let entries;
    try {
      entries = import_node_fs3.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = import_node_path3.default.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) total += 1;
    }
  }
  return total;
}
function printInit(engine) {
  const stats = engine.stats();
  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
  console.log("");
  console.log("✔ ai-persistent-memory 已初始化");
  console.log(`  根目录   ${engine.paths.root}`);
  console.log(`  数据库   ${engine.paths.dbFile}`);
  console.log(`  档案     ${engine.paths.archiveRoot}`);
  console.log(`  schema   v${SCHEMA_VERSION}`);
  console.log(`  记忆     ${total} 条`);
  console.log("");
  console.log("下一步：设置 DEEPSEEK_API_KEY，然后按 README 接入 DSH。");
}
function printStats(engine) {
  const stats = engine.stats();
  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
  console.log("");
  console.log("记忆状态");
  console.log("────────");
  for (const [state, count] of Object.entries(stats).sort()) {
    console.log(`  ${state.padEnd(10)} ${String(count).padStart(5)}`);
  }
  if (total === 0) console.log("  （空库）");
  console.log("────────");
  console.log(`  总计${" ".repeat(8)}${String(total).padStart(5)}`);
  let dbSize = 0;
  try {
    dbSize = import_node_fs3.default.statSync(engine.paths.dbFile).size;
  } catch {
    dbSize = 0;
  }
  console.log("");
  console.log(`数据库  ${formatBytes(dbSize)}  ${engine.paths.dbFile}`);
  console.log(`档案    ${countMarkdown(engine.paths.archiveRoot)} 个 Markdown  ${engine.paths.archiveRoot}`);
  console.log(`根目录  ${engine.paths.root}`);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help") {
    console.log(HELP);
    return;
  }
  if (args.command !== "init" && args.command !== "stats") {
    console.error(`未知命令：${args.command}
`);
    console.log(HELP);
    process.exitCode = 2;
    return;
  }
  const chosen = pickMemoryRoot(args.dbPath === null ? void 0 : args.dbPath);
  if (chosen.note) console.warn(chosen.note);
  const engine = new MemoryEngine({
    overrides: { memoryDbPath: chosen.root },
    ...hasNodeSqlite() ? { openDatabase: openNodeSqliteDatabase } : {}
  });
  try {
    if (args.command === "init") printInit(engine);
    else printStats(engine);
  } finally {
    engine.close();
  }
}
main().catch((error) => {
  if (!(error instanceof SystemDriveError)) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
  }
  process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map