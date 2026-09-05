import { JSON_SCHEMA, load } from "js-yaml";

export const WORKLINE_TRANSPORT_RECOVERY_MARKER = "traceink-local-transport-recovery-v1";

export interface WorklineTransportRecoveryResult {
  value: unknown;
  recovered: boolean;
  format: "json" | "yaml";
}

export function recoverWorklineTransport(
  text: string,
  schema: unknown
): WorklineTransportRecoveryResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const source = fenced?.[1]?.trim() ?? trimmed;
  const exact = parseExactJson(source);
  if (exact.ok) {
    assertSchema(exact.value, schema, "$", true);
    return { value: exact.value, recovered: false, format: "json" };
  }

  assertSafeRecoverySource(source);
  if (source.startsWith("{") || source.startsWith("[")) {
    throw recoveryError("带括号的畸形 JSON 不在受限恢复范围内");
  }

  const firstContentLine = source.split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (!firstContentLine || !/^(?:worklines|warnings)\s*:/.test(firstContentLine)) {
    throw recoveryError("首个顶层字段不是 worklines 或 warnings");
  }
  try {
    const value = load(source, { schema: JSON_SCHEMA });
    assertSchema(value, schema, "$", true);
    return { value, recovered: true, format: "yaml" };
  } catch (error) {
    throw recoveryError(errorMessage(error));
  }
}

function parseExactJson(source: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: parseDuplicateSafeJson(source) };
  } catch {
    return { ok: false };
  }
}

function parseDuplicateSafeJson(source: string): unknown {
  const value = JSON.parse(source) as unknown;
  // JSON.parse keeps the last duplicate key. js-yaml rejects duplicates, so this
  // second parse is a validation pass while JSON remains authoritative.
  load(source, { schema: JSON_SCHEMA });
  return value;
}

function assertSafeRecoverySource(source: string): void {
  if (!source || source.length > 4 * 1024 * 1024) throw recoveryError("内容为空或过大");
  const lines = source.split(/\r?\n/);
  if (lines.length > 50_000 || lines.some((line) => (line.match(/^ */)?.[0].length ?? 0) > 64)) {
    throw recoveryError("行数或缩进超过受限范围");
  }
  if (/\t|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(source)) throw recoveryError("包含控制字符或制表符");
  if (/(?:^|\n)\s*(?:%YAML|%TAG|---|\.\.\.)(?:\s|$)/m.test(source)) throw recoveryError("包含 YAML 指令或多文档标记");
  if (/(?:^|\s)#/.test(source)) throw recoveryError("包含 YAML 注释");
  if (/(?:^|[\s:[{,])(?:!!|![A-Za-z<])/.test(source)) throw recoveryError("包含 YAML 标签");
  if (/(?:^|[\s:[{,])[&*][A-Za-z0-9_-]+(?:\s|$)/.test(source)) throw recoveryError("包含 YAML anchor 或 alias");
  if (/^\s*<<\s*:/m.test(source)) throw recoveryError("包含 YAML merge key");
  if (/:\s*[>|][+-]?\s*(?:#.*)?$/m.test(source)) throw recoveryError("包含块标量");
  const lastEffectiveLine = [...lines].reverse().find((line) => line.trim());
  if (lastEffectiveLine?.trim() !== "transportComplete: true") throw recoveryError("缺少末尾完成标记");
}

function assertSchema(value: unknown, schema: unknown, path: string, checkJsonSafe: boolean): void {
  const rule = asRecord(schema);
  if (!rule) throw new Error(`${path} schema 无效`);
  if (checkJsonSafe || typeof value === "number") assertJsonSafeScalar(value, path);
  if (Array.isArray(rule.anyOf)) {
    const failures: string[] = [];
    for (const candidate of rule.anyOf) {
      try {
        assertSchema(value, candidate, path, false);
        return;
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    throw new Error(`${path} 不符合任何允许结构：${failures.join("；")}`);
  }
  const allowedTypes = Array.isArray(rule.type) ? rule.type : typeof rule.type === "string" ? [rule.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    throw new Error(`${path} 类型不符合合同`);
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) {
    throw new Error(`${path} 不在允许值中`);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSchema(item, rule.items, `${path}[${index}]`, true);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const properties = asRecord(rule.properties) ?? {};
  const required = Array.isArray(rule.required) ? rule.required.filter((item): item is string => typeof item === "string") : [];
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key} 缺失`);
  }
  if (rule.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`${path}.${key} 不在合同中`);
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(record, key)) assertSchema(record[key], childSchema, `${path}.${key}`, true);
  }
}

function assertJsonSafeScalar(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Array.isArray(value) || asRecord(value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${path} 包含非 JSON 安全数字`);
    return;
  }
  throw new Error(`${path} 包含非 JSON 安全类型`);
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return asRecord(value) !== undefined;
  return typeof value === type;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryError(detail: string): Error {
  return new Error(`工作脉络输出无法安全恢复：${detail}`);
}
