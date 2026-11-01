> ⚠️ 本项目处于 Beta 阶段：默认值与内部结构可能变动，遇到 Bug 欢迎提 Issue。

<div align="center">

# ai-persistent-memory

**本地长效记忆：写进去、存两份、按半衰期遗忘**

`TypeScript strict` · `SQLite (WAL)` · `Markdown 双写` · `DSH 插件 / 可复用库`

[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

> 全会是失忆，全不忘是硬盘。

作者：**一株紫罗兰**

<sub>设计思路参考公开资料（遗忘曲线、间隔重复、RAG 式按需注入、命名空间隔离等），代码为独立实现；README 文案与部分实现由 AI 辅助生成。</sub>

</div>

---
## 设计灵感与致谢

本项目的整体架构灵感，最初来源于 DSH 社区中流传的一张关于“大肥鱼记忆系统”的架构图（包含“分线不分人”“五级生命周期”“原文不压缩”等理念）。

由于该图经过多次传播，我未能追溯到最原始的发布者或作者。在此，向该图的创作者，以及社区中所有探索“大肥鱼”记忆系统的开发者们致以诚挚的感谢。如果您是这张图的作者，或者知情者，欢迎随时联系我，我会在此处补上您的署名。


## 它做什么

DeepSeek Harness（DSH）以及其它 Agent 的会话默认不跨轮保留信息：换一个会话，
昨天说过的偏好、事实、情绪就都不再被提及。这个插件在 DSH 里加了一层**完全本地**的记忆：

- **写进去**：一轮对话结束后用 LLM 抽出结构化条目（事实 / 当时感觉+强度 / 当时在想 / 后来再想 / 回忆补），原文逐字保留；
- **存两份**：SQLite 给机器检索，Markdown 给人随时翻；
- **用起来**：`score = 语义 × 衰减权重 × 情绪系数`，命中后顺同标签扩散一轮，装进系统提示；
- **允许忘**：事实 90 天 / 看法 60 / 观察 45 / 事件 30 的半衰期；冷存 90 天，冷存满 365 天物理删除；
- **分区**：全局记忆（self）跨线共享，角色线（mask）与项目线（project）各自独立。

数据层不依赖任何云服务。抽取环节可以配 DeepSeek API Key 走大模型；**不配也能用**，
此时退化为「本地低价值过滤 + 整轮原文落一条 event」。

## 它不做什么（能力边界）

边界清楚，用起来才放心：

| 不做 | 说明 |
|---|---|
| 不做向量库封装 | 检索走本地关键词（中文 bigram + 英文词 + 短语命中 + 标签加成），不依赖任何外部向量服务 |
| 不注册 `memory_*` 工具 | 只做「自动召回 + 自动落盘」，工具面留给单独的 tools 插件，避免同名工具重复注册 |
| 不自动切到别的盘 | 配了 `C:` 或含 `AppData` 的路径会直接拒绝启动；只有「配的盘不存在」时才自动找 D→E→F… |
| 不做多用户 / 多设备同步 | 单文件 SQLite，单用户本地使用 |
| 不保存完整会话日志 | 只保存抽取后的记忆与（无 Key 时的）整轮原文；会话日志仍然是 DSH 自己的 |

## 记忆模型

### 记忆条目：事实 + 情绪 + 反思

一条记忆 = 发生了什么 + 当时的情绪强度 + 事后的想法与补充。
这是情景记忆（episodic memory）里常见的结构，落到表里就是这几个字段：

```
fact          事实（发生了什么，一句话）
feltThen      当时感觉（可空）
intensity     情绪强度 0-10
thoughtThen   当时在想（可空）
reframe       后来再想（可空）
recalledLater 回忆补（可空）
rawText       原文，逐字保留，永不改写
summary       机器摘要，只参与排序，永不覆盖 rawText
```

### 双写

| 存储 | 用途 |
|---|---|
| SQLite（`memory.db`，WAL） | 机器检索、防重、生命周期、账本 |
| Markdown（`01_记忆/`、`02_日记/`） | 人随时翻；每次写入都是「读全文 → 改 → 临时文件 → 原子替换」，不会留下半个文件 |

Markdown 布局：

```text
<archiveRoot>/
├── 01_记忆/
│   ├── 事实.md  看法.md  观察.md  事件.md
│   ├── 情绪账.md                ← 强度 ≥ 6 的条目单独汇总，跨线共享
│   ├── 面具/<uid>/<类别>.md     ← 角色线（mask）
│   └── 项目/<slug>/<类别>.md    ← 项目线（project）
└── 02_日记/每天的流水/<日期>.md
```

每条内容都带 `<!-- apm:id=<uuid> -->` 标记，删除时按标记精确清除，不会动用户自建的 `.md`。

### 检索与打分

召回走的是「检索增强」的通用做法：先从本地库里挑出相关条目，再按预算拼进系统提示。
候选默认只取活跃记忆（冷存不参与注入）。

```text
语义 semantic = min(1, 覆盖率×0.7 + 短语命中(0.3) + 标签加成(≤0.2))
衰减权重     = weight × 0.5 ^ (距上次被加强的天数 / 半衰期)
情绪系数     = 1 + intensity / 5          // 1.0 - 3.0
score        = semantic × 衰减权重 × 情绪系数
```

「上次被加强」= max(写入时间, 最近被想起时间, 最近复习时间)：**被想起会刷新遗忘计时**。

扩散只走一层：同标签扩散——只有最高分 ≥ 1 时才触发，顺 `tags` 最多再捞 2 条旧事。

上下文预算：按「条」整块跳过，**绝不截断半句话**；一条都装不下就整块不注入。

### 生命周期（冷热分层）

参照常见的冷热分层（hot / cold tiering）：常用的留在活跃层，久未使用的沉到冷存，更久的清理。

| 状态 | 含义 | 参与检索 | 物理删除 |
|---|---|---|---|
| `active` 活跃 | 正常记忆 | ✅ | — |
| `cold` 冷存 | 90 天没被想起 **且** 有效权重 < 0.6 | ❌ | — |
| 清理 | 冷存满 365 天 | — | ✅ 写墓碑后删除 |

半衰期：`fact 90d / opinion 60d / observation 45d / event 30d`。
衰减用指数曲线，也就是艾宾浩斯遗忘曲线 / 间隔重复里那套通用模型。
复习（数字核对）把基础权重 ×1.6，上限 3 倍。
冷存条件里的「90 天」与「0.6」都是硬条件，必须同时满足。

### 记忆分区（Scope / 命名空间）

按作用域分区，思路取自常见的多租户 / 命名空间隔离：同一条记忆只在自己的线里生效，互不串味。

`scope ∈ {self, mask, project}`：

- `self`（全局）：所有线共享，不允许带 `scopeRef`；
- `mask`（角色）/ `project`（项目）：必须带非空 `scopeRef`（uid / slug），只见自己这条线 + 全局。

写入前会校验这套组合，写错直接报错。

## 数据流

```text
用户消息
  │
  ├─ 模型调用前（agent/pre-step）
  │    ├─ 召回：候选（仅活跃）→ 打分 → 同标签扩散 → 按预算装配
  │    ├─ 组装注入块：人设 + 【潜意识背景印象】+ 使用指南
  │    └─ 开关「减少历史消息」打开时，把本轮 messages 裁到最近 10 条
  │
  ├─ 系统提示（order 10）
  │    └─ 读上面组好的注入块；没有内容就返回空串
  │
  ├─ 模型调用
  │
  ├─ 回复成功
  │    └─ 被用到的记忆 recall_count +1，刷新遗忘计时
  │
  └─ 轮次结束（异步，不阻塞收尾）
       └─ 抽取结构化条目 → 6 小时防重 → SQLite + Markdown
            没有 API Key 时：本地低价值过滤后，整轮原文落一条 event
```

启动时还会做一次后台维护（距上次超过 24h 才跑，不阻塞首轮对话）。

## 安装

### 方式一：DSH 插件（推荐给普通用户）

```bash

#  GitHub 仓库
dsh plugin --profile desktop add "github:Guan-Blip/dsh-persistent-memory"
```

装完**完全退出 DSH 再打开**（含托盘），然后进 **设置 → 左侧「🧠 长期记忆」**。

> 先确认 profile 名：`$env:DSH_PROFILE`，或看 `$env:DSH_HOME\profiles`。
> 往 `--profile web` 装的东西不会出现在 desktop 界面里。

仓库自带 `install.ps1`：

```powershell
.\install.ps1                       # 默认装进 desktop
.\install.ps1 -Profile web
.\install.ps1 -Source "github:Guan-Blip/dsh-persistent-memory"
```

### 方式二：作为库 import

```bash
npm install ai-persistent-memory
```

```ts
import { MemoryEngine, DshAdapter, MemoryExtractor, DeepSeekClient } from 'ai-persistent-memory';
```

## CLI

```bash
ai-memory init  [--path D:\AI_Memory]   # 建目录 + 建库 + 写 schema
ai-memory stats [--path D:\AI_Memory]   # 各状态条数、数据库大小、Markdown 数量
ai-memory --help
```

省略 `--path` 时使用默认 `D:\AI_Memory`；没有 D 盘时自动找第一个可写的非 C 盘，
一个可用盘都没有才报错。以 `C:` 开头或包含 `AppData` 的路径会被直接拒绝。

## 编程接入

### 适配层（推荐）

```ts
import {
  MemoryEngine,
  MemoryExtractor,
  PromptFormatter,
  DshAdapter,
  DeepSeekClient,
} from 'ai-persistent-memory';

const engine = new MemoryEngine({
  overrides: { memoryDbPath: 'D:\\AI_Memory' },
});

const llm = new DeepSeekClient(engine.config.llm);   // 读 DEEPSEEK_API_KEY
const adapter = new DshAdapter({
  engine,
  extractor: new MemoryExtractor({ llm }),
});

// ── 每轮：模型调用前 ──────────────────────────────
const prepared = await adapter.prepare({
  sessionId,
  conversationId,
  turnId,
  userText,
  history: messages,     // 本轮之前的消息
  scope: 'self',         // 角色线传 'mask' + scopeRef
  scopeRef: null,
});

const messagesWithMemory = adapter.inject(messages, prepared);
const reply = await dsh.chat(messagesWithMemory, { stream: true });

// ── 模型成功返回后（超时/取消不要调用 success）──
await adapter.complete({ sessionId, conversationId, turnId, userText }, prepared, reply);

// 常驻进程里再起一个维护调度器
import { Scheduler } from 'ai-persistent-memory';
new Scheduler({ engine }).start();
```

`DshAdapter.complete` 的内部顺序：

1. `success !== false` 才 `markRecalled`——只有真正送进模型并成功返回，才算想起来；
2. 异步 `MemoryExtractor.extract`（默认不阻塞回复）；
3. 每条 draft 调 `engine.saveMemory`，6 小时防重后双写。

### 手动接入

```ts
import {
  MemoryEngine, MemoryExtractor, PromptFormatter,
  WorldContextBuilder, DeepSeekClient,
} from 'ai-persistent-memory';

const engine = new MemoryEngine();               // D:\AI_Memory
const extractor = new MemoryExtractor({ llm: new DeepSeekClient(engine.config.llm) });
const world = new WorldContextBuilder(engine.repository, engine.clock).build({
  scope: 'self', scopeRef: null, sessionId,
});
const recalled = await engine.recall({ text: userText, scope: 'self', sessionId });
const injection = new PromptFormatter().format({ memories: recalled.items, world });

// 注入 injection.text 后调模型；成功后：
await engine.markRecalled(injection.memories.map((m) => m.memory.id));

// 轮次结束：
const { drafts } = await extractor.extract({
  turns, scope: 'self', scopeRef: null,
  conversationId, sessionId, turnId,
});
for (const draft of drafts) await engine.saveMemory(draft);
```

> `WorldContextBuilder` 会给出「今天 / 心情 / 今天发生 / 未完成 / 最近聊过」，
> 需要世界资料时把它拼进注入文本即可。

## 配置

```ts
new MemoryEngine({
  overrides: {
    memoryDbPath: 'D:\\AI_Memory',
    retrieval: { topK: 8, budgetTokens: 1200, expandHops: 1 },
    dedupe: { windowMs: 6 * 60 * 60 * 1000, similarityThreshold: 0.92 },
    lifecycle: { coldAfterDays: 90, purgeAfterDays: 365 },
    embedding: { enabled: false },
    llm: { model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
});
```

全部默认值（`src/config.ts` 的 `DEFAULT_CONFIG`）：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `memoryDbPath` | `D:\AI_Memory` | 记忆库根目录；`C:` 或含 `AppData` 会拒绝启动 |
| `archive.enabled` / `root` | `true` / `null` | `null` = 跟随 `memoryDbPath` |
| `backup.retention` | `3` | 清空时保留的快照份数（1–50） |
| `embedding.enabled` | `false` | 向量检索开关（默认关闭，走本地关键词） |
| `embedding.model` / `dim` | `bge-small-zh-v1.5` / `512` | 两者必须匹配，否则报配置错误 |
| `retrieval.topK` | `8` | 召回条数（1–50） |
| `retrieval.minScore` | `0.05` | 相关性门槛（0–1）；插件里由敏感度换算后覆盖 |
| `retrieval.expandHops` | `1` | 一轮扩散；只能是 0 或 1 |
| `retrieval.expandFactor` | `0.55` | 传播分衰减系数（0–1） |
| `retrieval.maxExpanded` | `6` | 扩散最多带出几条（0–50） |
| `retrieval.budgetTokens` | `1200` | 注入预算（100–20000） |
| `dedupe.windowMs` | `6h` | 防重窗口（1 分钟 – 7 天） |
| `dedupe.similarityThreshold` | `0.92` | 近似重复阈值（0.5–1） |
| `dedupe.includeSealed` | `true` | 封存的旧条也参与防重 |
| `lifecycle.coldAfterDays` | `90` | 冷存天数（1–3650） |
| `lifecycle.purgeAfterDays` | `365` | 清理天数，必须大于 `coldAfterDays` |
| `lifecycle.coldRetentionThreshold` | `0.6` | 冷存权重阈值（0–3） |
| `lifecycle.sweepIntervalHours` | `6` | 扫描周期（1–168 小时） |
| `llm.provider` | `deepseek` | `deepseek` / `openai-compatible` / `mock` |
| `llm.model` | `deepseek-chat` | 提取用模型 |
| `llm.baseUrl` | `https://api.deepseek.com` | 必须 http(s):// 开头 |
| `llm.apiKeyEnv` | `DEEPSEEK_API_KEY` | 只从环境变量读密钥，不写进配置文件 |
| `llm.temperature` / `timeoutMs` / `maxRetries` | `0.2` / `30000` / `2` | 提取请求参数 |

插件侧配置写在 `patches/bundle.yaml` 的 `config` 里：

| 字段 | 默认 | 说明 |
|---|---|---|
| `memoryDbPath` | `D:\AI_Memory` | 记忆库根目录 |
| `driver` | `auto` | `auto` → 优先 `node:sqlite`，不可用才 `better-sqlite3` |
| `topK` | `8` | 召回条数（1–50） |
| `budgetTokens` | `1200` | 注入预算（100–20000） |
| `extract` | `true` | 轮次结束后用 LLM 抽结构化记忆（需 `DEEPSEEK_API_KEY`） |
| `rawFallback` | `true` | 没有 API Key 时，整轮原文落盘为一条 `event` 记忆 |
| `maintenance` | `true` | 进程内启动遗忘调度器 |
| `scope` / `scopeRef` | `self` / — | 插件固定写入的线 |

## 定时维护

```ts
import { Scheduler } from 'ai-persistent-memory';

const scheduler = new Scheduler({
  engine,
  // 可选：覆盖任意档期
  handlers: {
    daily_digest: async ({ engine, now }) => ({ status: 'succeeded', stats: {} }),
    weekly_story: async ({ engine, now }) => ({ status: 'succeeded', stats: {} }),
  },
});
scheduler.start();
```

默认档期（本地时间）：

| 档期 | 时间 | 默认行为 |
|---|---|---|
| `nightly_review` | 00:00 | 生命周期扫描 + 随机复习 3 条（权重 ×1.6） |
| `consolidate` | 23:00 | 精确重复合并（同 `content_hash`，保留最早一条） |
| `daily_digest` | 23:50 | 可选：注入 LLM 处理器后生成每日摘要 |
| `weekly_story` | 周日 22:30 | 可选：注入 LLM 处理器后生成每周回顾 |

可靠性：每 30 秒 tick 一次，同一档期只跑一次；
睡眠/关机错过的档期，下次启动补跑最近一次（默认回看 2 天）。

插件启动时另有一条「启动触发版」维护：读 `meta` 里的 `plugin.last_maintenance`，
超过 24h 才后台跑一次——扫描 + 合并 + 写一条每日流水 `event`。

## 设置面板与 HTTP 接口

`client.js` 是浏览器侧 Client 插件，注册为设置页**左侧导航的一级入口**：

```js
ctx.slots.register(
  { name: 'settings.section', id: 'ai-persistent-memory', order: 30, label: '🧠 长期记忆' },
  MemorySection,
);
```

> `settings.section` 的注册选项只有 `id` / `order` / `label`（官方 slot 契约），没有图标字段。
> 所以导航行用 emoji 当图标，矢量图标画在页面标题区。

面板内容：

- 顶部：记忆总条数、库/档案路径、占用大小，带【刷新】；【一键清空】与【💀 彻底重置】。
- **5 个运行时开关**：自动带上记忆 / 自动记住新内容 / 限制记忆占用长度（800 token）/
  减少历史消息（滑动窗口）/ 启用记忆保护（高兼容注入，默认关闭）。
- **记忆写入模式**：`auto`（自动抽取）/ `manual`（只查不记）/ `off`（关闭写入）。
  非 `auto` 时后端直接跳过后台抽取，不做无谓的 Token 消耗。
- **记忆敏感度**滑块 0-100，后端换算 `minScore = (100 - 敏感度) / 100`（默认 50 → 0.5）。
- **手动记住一件事**输入框（界面限 500 字，接口上限 2000 字）。
- **AI 人设** Textarea：注入时会被包进固定安全外壳，无法覆盖安全准则。
- **存储位置**：点盘符或手填绝对路径 → 保存。保存只写配置，**重启 DSH 后生效**；
  换位置后新位置是空的，旧数据仍留在原路径。
- 底部折叠的「危险操作（卸载本插件）」：只弹窗给出命令，不执行代码卸载。

Host 侧注册的接口：

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/api/ai-persistent-memory/stats` | `{ ok, total, byState, dbPath, archiveRoot, backupsDir, memoryRoot, availableDrives, dbBytes, settings }` |
| `GET` / `POST` | `/api/ai-persistent-memory/settings` | 读 / 局部更新开关、写入模式、人设、敏感度、存储位置 |
| `POST` | `/api/ai-persistent-memory/memorize` | 手动记一件事（注入时单独包安全外壳） |
| `POST` | `/api/ai-persistent-memory/maintenance` | 立刻跑一次维护（force） |
| `POST` | `/api/ai-persistent-memory/clear` | 先在 `backups\backup-<时间戳>` 生成快照，再清表 + 删 Markdown；需 `{"confirm":"YES"}`（不区分大小写） |
| `POST` | `/api/ai-persistent-memory/nuke` | 彻底重置：清表 + 递归删除全部快照（兼容旧版兄弟备份目录）；需 `{"confirm":"YES"}`（**严格大写**） |

没有 Web 宿主的 profile（例如纯 headless）里接口不注册，插件其余功能照常。

### 注入格式与权重

`systemPrompt.section` 的排序只由 `order` 决定（升序，同 order 按 name）。
官方 order 表：

| 段落 | order |
|---|---|
| HARNESS_IDENTITY | -1000 |
| DEPLOYMENT_PERSONA_PREFIX（人设前缀） | 0 |
| **本插件（记忆）** | **10** |
| PLAN_POLICY | 500 |
| TOOL_BASH / TOOL_READ / … | 1000+ |

取 10 = 紧跟人设、早于计划与全部工具说明。

实际注入正文（`PromptFormatter`）：

```text
【你现在的人设是：<用户人设，默认「智能助手」。】
你拥有极好的记忆：知道的事自然带入对话，绝不邀功，绝不做任何系统播报。
不要对用户说「我没有跨会话记忆」「我把内容写进了某个文件」「已存入记忆库」「我记住了」，也不要用「文件 / 数据库 / 记录 / 存下来」来描述自己记住某事。
（正常讨论用户自己的文件、数据库、日志不受此限。）
【潜意识背景印象（以下是你的常识，请自然融入思考，绝对不要复述，也不要使用「根据记录」等词汇）：】
- 眼前的这个人喜欢美式咖啡，不加糖。
- 眼前的这个人最近在折腾 DSH 插件。
像人聊天时不会刻意提自己的常识一样，只有当话题自然相关时，再像潜意识一样运用这些印象。
```

- **记忆脱敏**：一条印象都没命中时（例如只说了「你好」），整块不注入，直接返回空串；
- **打招呼降级**：打招呼且最高分 < 0.7 时不注入；
- **高兼容模式**（弱模型）：开启后压成一句话（20-30 字内），去掉命令式措辞，只取最高分的一条：

```text
【背景参考（请自然带入对话）：对方喜欢美式咖啡。】
```

## 安全设计

### 1. 路径红线：为什么拒绝 C 盘

`memoryDbPath` 以 `C:` 开头、或任意层级包含 `AppData`，会在**建库之前**直接报错中止；
不会静默改到 D 盘。面板的存储位置同样拦（安全红线不因 UI 而松动）。

唯一的例外是「配的盘不存在」：此时按 D→E→F… 找第一个可写的非 C 盘，落到 `<盘>:\AI_Memory`，
并在日志里说明「已自动改用 …」。一个可用盘都没有时才报错。

### 2. 结构化隔离（提示注入防护的常见做法，不做关键词黑名单）

关键词黑名单既容易被变形词绕过，又会误伤正常讨论（用户完全可能正经地聊 "system prompt"）。
所以这里用结构隔离：

1. **固定外壳**：人设与额外背景都包在写死的安全外壳里，动态文本无法跳出外壳改写规则；
2. **结构转义**：注入前把 `【】`、`[]`、`{{ }}` 这类结构符号换成全角变体，控制字符换成空格；
3. **原文不改写**：转义只发生在注入那一刻，库里的原文逐字保留——连全角标点都不做归一化，
   否则等于悄悄改写用户的原话；
4. 剩下的交给底层模型的安全对齐兜底。

<details>
<summary>实现细节</summary>

- 人设走 `personaRule()`，额外背景走 `wrapExtraMemory()`，两处外壳的安全条款都是写死的；
- 转义函数 `escapeStructure()`：`【】` → `［］`、`[]` → `［］`、`{{` `}}` → `｛｛` `｝｝`；
- `escapeStructure` 刻意不做 NFKC：NFKC 会把全角标点改成半角，等于改写原话；
- 「手动记忆」用同一个 `wrapExtraMemory()` 包外壳。

</details>

### 3. 彻底删除：先清明文，再清库

清空 / 重置的顺序是固定的：

1. 先扫 `01_记忆` 与 `02_日记`，只清除带插件标记的内容——**不会动用户自建的 `.md`**；
2. 再清空记忆表、标签表、关联表、墓碑表与日志类表（保留设置）；
3. 最后压缩数据库文件，把残留明文一起抹掉。

快照与保留策略：

```text
<memoryDbPath>\backups\backup-2026-10-30T12-31-42-246Z\   ← 每次清空一份
```

- `backupRetention` 默认 3（`backup.retention` 与 `meta` 的 `plugin.backup_retention` 均可配，1–50）；
- 生成新快照后自动裁剪更老的，**刚生成的那份永不删除**；
- 删除路径严格限制在 `backups` 之内。

**彻底重置（nuke）** 是最危险的操作，三道防线：

1. 前端：不可关闭弹窗 + **5 秒倒计时** + 必须手打大写 `YES`；
2. 后端：口令必须严格等于 `YES`（小写拒绝）；
3. 路径：删除目标必须位于 `backups` / 旧版兄弟备份目录，否则整单拒绝。

<details>
<summary>实现细节</summary>

- 清档案：`purgeArchiveMarkdown()`，跳过 `backups` / `.models` / `logs`；
- 清库：`repo.clearAllMemoryData()`，清 `memories` + `memory_tags` + `memory_embeddings` + `memory_links` + `memory_tombstones`；
- 收尾：`wal_checkpoint(TRUNCATE)` + `VACUUM`，把 WAL 与空闲页里的残留明文一起抹掉。

</details>

### 4. 数据可靠性

- 时间统一用 UTC，跨时区也不会乱序；
- 写操作串行化：先拿写锁再检查，并发下不会写出两条重复记忆；
- 物理删除只留指纹（`content_hash`，不含正文），防重审计与隐私兼顾；
- 库结构版本比代码新时拒绝启动，避免旧版本写坏新库；
- 库打不开就明确报错，不会带着半残状态继续跑。

<details>
<summary>实现细节</summary>

- 所有表 `STRICT`，写错类型直接报错；
- 每个连接都执行 `WAL` + `busy_timeout` + `foreign_keys`；WAL 起不来就拒绝启动；
- 写操作走 `BEGIN IMMEDIATE`，读操作走 deferred 快照；
- `schema_version` 比对后再决定是否启动。

</details>

## 打包与分发

本库可以同时作为**可复用库**（`npm i ai-persistent-memory`）和 **DSH 插件包**使用。
插件包 = 一个 bundle（`patches/bundle.yaml`）+ 一个插件入口（`lib/index.js`，CommonJS）。
DSH 用 `import()` 加载后自动归一化导出，所以**不需要**在宿主侧编译任何东西。

```text
.
├── package.json          # main → lib/index.js；dsh.bundle.patch → patches/bundle.yaml
├── tsup.config.ts        # TS → CJS 打包
├── patches/bundle.yaml   # loader patch：把插件行 insert 进 profile
├── lib/index.js          # 构建产物（插件入口，纯 JS）
├── client.js             # 设置页前端（settings.section）
├── locale/{zh,en}.json   # 插件管理器里的标题/描述
└── icon.svg
```

> **`patches/bundle.yaml` 不能写成 `[]`。**
> `[]` 语法合法，但含义是「本 bundle 不贡献任何插件行」——安装后能在插件列表里看到这个包，
> 插件却不会启动（不召回、不落盘）。必须写一条 `insert` 行。

`package.json` 里必须保留这些声明：

```json
"main": "./lib/index.js",
"exports": { ".": "./lib/index.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "patches/bundle.yaml" },
  "client": { "platform": "web", "immediately": true }
}
```

### 三种分发方式怎么选

| 方式 | 用户命令 | 适合 | 代价 |
|---|---|---|---|
| **npm 发包（首选）** | `dsh plugin --profile desktop add ai-persistent-memory` | 长期维护、要版本号、要别人无脑装 | 需要 `npm publish` 一次（包名要没被占） |
| **GitHub 直装（次选）** | `dsh plugin --profile desktop add "github:Guan-Blip/dsh-persistent-memory"` | 不想碰 npm、想直接发链接 | 必须把 `lib/` 和 `client.js` 提交进仓库 |
| `link:` 本地目录 | `add "link:F:\你的路径"` | **只适合自己开发** | 别人得先 clone 到固定路径，且没有版本管理 |

`pnpm add github:Guan-Blip/dsh-persistent-memory` 只取仓库里已有的文件，**不会**替你跑 `npm run build`。
所以发布前先构建，再把产物提交上去：

```powershell
npm run build
git add lib client.js patches locale icon.svg package.json install.ps1
git commit -m "build: ship compiled plugin"
git push
```

`.gitignore` 里没有忽略 `lib/` 与 `client.js`，所以按上面的流程走即可。

### 零配置说明

**不需要**让用户装 Node.js、不需要 `npm install`、不需要编译任何原生模块——
数据层默认走进程内置的 `node:sqlite`（Node ≥ 22.5 / Electron ≥ 30 自带），
`better-sqlite3` 只是可选依赖（没有也能跑）。

<details>
<summary>为什么 better-sqlite3 是可选的（给贡献者）</summary>

- `better-sqlite3` 是原生模块，按**系统 Node** 的 ABI 编译；DSH 桌面端跑在 **Electron** 主进程里，
  两者 `NODE_MODULE_VERSION` 不同，直接 require 会报错，真要用得用 `@electron/rebuild` 按 Electron 版本重编。
- 也**别**把它放回 `dependencies` / `optionalDependencies`：pnpm 默认会忽略未批准的原生构建脚本
  （`ERR_PNPM_IGNORED_BUILDS`），`dsh plugin add` 会直接失败。
  本仓库把它放在 `peerDependencies` + `peerDependenciesMeta.optional`，需要的人自己装、
  并把 `driver` 设为 `better-sqlite3`。
- 构建时 `better-sqlite3` 必须保持 external（不打包）：它是 `.node` 二进制，内联进 bundle 必然加载失败。

</details>

### 本地验证「别人装得上」

发布前用打包产物模拟一次全新安装（不污染自己的 profile）：

```powershell
npm pack                                     # 生成 ai-persistent-memory-<version>.tgz
dsh plugin --profile test add .\ai-persistent-memory-<version>.tgz
dsh --profile test --dump-config | Select-String 'ai-persistent-memory'
```

## 构建与自检

```powershell
npm install
npm run typecheck    # tsc --noEmit，只类型检查
npm run build        # tsup → CommonJS 产物
```

产物（`lib/`）：

```text
lib/index.js                     插件入口（CommonJS，DSH 直接 require/import）
lib/adapters/agent/DshAdapter.js 薄适配层，可单独 require
lib/cli/cli.js                   CLI
```

构建后的自检：

```powershell
# ① 产物是纯 CJS，且插件面齐全
node -e "const m=require('./lib/index.js'); console.log(m.name, typeof m.apply, m.inject)"

# ② CLI 仍然可用
node lib/cli/cli.js stats --path "D:\AI_Memory"
```

<details>
<summary>构建配置的两个注意点</summary>

- `tsup.config.ts` 把源码里的 `import.meta.url` 用 `define` 换成由 banner 定义的常量（CJS 产物没有 `import.meta`）；
- `charset` 设为 `utf8`，保留中文原文，便于发布后直接 grep 提示词。

</details>

## 目录结构

```text
src/
├── core/          MemoryEngine / schema / decay / scoring / dedupe / guard
├── extractor/     MemoryExtractor / prompts / 容错 JSON
├── injector/      PromptFormatter / WorldContextBuilder
├── adapters/
│   ├── storage/   MemoryRepository（唯一 SQL 出口）/ NodeSqliteAdapter
│   ├── archive/   MarkdownArchive（原子写 + 回滚）
│   ├── llm/       DeepSeekClient / StaticLlmClient
│   └── agent/     DshAdapter（插件入口 + HTTP 接口 + 设置读写）
├── maintenance/   Scheduler（幂等补跑）
├── cli/           init / stats
└── index.ts       公共出口
client.js          设置页前端
patches/bundle.yaml loader patch
locale/{zh,en}.json 插件元信息
```

## 设计参考与声明

本项目用到的都是公开的通用思路，没有独创概念，代码为独立编写：

| 思路 | 通用叫法 | 在本项目里的体现 |
|---|---|---|
| 遗忘曲线 | 艾宾浩斯遗忘曲线、间隔重复（spaced repetition） | 按半衰期做指数衰减，被想起会刷新计时 |
| 检索增强注入 | RAG（Retrieval-Augmented Generation） | 先本地召回，再按 token 预算注入系统提示 |
| 情景记忆 + 情绪标记 | episodic memory / affect tagging | 事实 + 情绪强度 + 事后反思的结构化条目 |
| 冷热分层 | hot / cold tiering | 活跃 → 冷存 → 清理 |
| 命名空间隔离 | 多租户 / namespace / scope | self / mask / project 三条线互不串味 |
| 提示注入防护 | prompt injection mitigation | 固定外壳 + 结构转义，而不是关键词黑名单 |

> 与市面上其它记忆类插件、RAG 框架在概念上会有重合——同一个问题，常见的解法本来就那几种。
> 本项目的表结构、打分公式、文案均为独立编写，参考的是上面这些公开资料与通用工程实践。

**AI 辅助声明**：本 README 的文案，以及项目中的部分代码、注释与文档，由 AI 辅助生成，
经作者审阅后发布。如果你发现某段表述与你的项目雷同，欢迎提 Issue 沟通。

## License

MIT © 一株紫罗兰

完整条款见 [LICENSE](./LICENSE)。
