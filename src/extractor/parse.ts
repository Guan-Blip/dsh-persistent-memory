/**
 * LLM 输出的容错解析。
 *
 * 模型经常犯的错，这里都兜住：
 *   - 外面包了 ```json 代码块；
 *   - JSON 前后有“好的，以下是……”；
 *   - 末尾多一个逗号；
 *   - 直接返回数组而不是 { memories: [] }。
 * 仍然解析失败就返回 ok=false，由提取器优雅降级（空结果 + 记录原因）。
 */

export type LooseParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export function parseLooseJson(raw: string): LooseParseResult {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { ok: false, reason: '空响应' };

  const candidates = new Set<string>();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.add(fence[1].trim());
  candidates.add(trimmed);

  const extracted = extractJsonFragment(trimmed);
  if (extracted) candidates.add(extracted);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== undefined) return { ok: true, value: direct };

    const repaired = tryParse(repairJson(candidate));
    if (repaired !== undefined) return { ok: true, value: repaired };
  }

  return {
    ok: false,
    reason: `无法解析为 JSON（前 120 字符：${trimmed.slice(0, 120)}）`,
  };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 扫描第一个 { 或 [，按括号配对截出完整片段；字符串内的括号不计。 */
function extractJsonFragment(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const opening = text[start] as '{' | '[';
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function repairJson(text: string): string {
  return text
    // 尾逗号：{"a":1,} / [1,]
    .replace(/,\s*([}\]])/g, '$1')
    // 中文引号
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}
