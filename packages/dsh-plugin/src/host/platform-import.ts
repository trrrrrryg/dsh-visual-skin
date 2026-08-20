/**
 * DeepSeek Open Platform import: reads the platform session token from the
 * local Edge/Chrome localStorage LevelDB (the private dashboard endpoints
 * need the web-session userToken, NOT the API key), then pulls the official
 * per-day usage (tokens) and cost (CNY) for one month and aggregates them
 * into the local ledger's DayUsage shape.
 *
 * The platform endpoints are private dashboard APIs (no public documentation):
 *   GET https://platform.deepseek.com/api/v0/usage/amount?month=M&year=Y
 *   GET https://platform.deepseek.com/api/v0/usage/cost?month=M&year=Y
 *   GET https://platform.deepseek.com/api/v0/users/get_user_summary
 * Auth is `Authorization: Bearer <userToken>`; code 40002/40003 means the
 * session is missing or expired.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLATFORM_BASE = "https://platform.deepseek.com";
const PLATFORM_TIMEOUT_MS = 15_000;
const ORIGIN = "https://platform.deepseek.com";
const TOKEN_KEY = `_${ORIGIN}\x00\x01userToken`;

// ---------------------------------------------------------------------------
// Minimal LevelDB reader (SSTables + write-ahead logs) good enough to read
// Chrome/Edge "Local Storage/leveldb" directories. All parsing is read-only
// and permissive: any unreadable/locked file is skipped, a malformed block
// aborts that block only, and the scan never throws.
// ---------------------------------------------------------------------------

interface RawEntry { key: Buffer; value: Buffer }
export interface LevelDbRecord { key: Buffer; value?: Buffer; sequence: bigint; deleted: boolean }
export interface PlatformTokenCandidate { token: string; source: "edge" | "chrome"; profile: string }

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos]!;
    pos += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: pos };
    shift += 7;
    if (shift > 35) return { value: -1, next: pos };
  }
  return { value: -1, next: pos };
}

/**
 * Raw snappy (no framing). Per the official format_description.txt:
 *   - literals:  (lenCode < 60 ? lenCode + 1 : 1 + LE(length bytes))
 *   - copy w/ 1-byte offset:  length = 4 + ((tag >> 2) & 7)
 *   - copy w/ 2- or 4-byte offset:  length = 1 + (tag >> 2)
 */
function snappyUncompress(input: Buffer): Buffer {
  const len = readVarint(input, 0);
  if (len.value < 0 || len.value > 64 * 1024 * 1024) throw new Error("bad snappy length");
  const out = Buffer.allocUnsafe(len.value);
  let pos = len.next;
  let written = 0;
  while (pos < input.length) {
    const tag = input[pos]!;
    pos += 1;
    const type = tag & 3;
    if (type === 0) {
      const lenCode = tag >> 2;
      let litLen: number;
      if (lenCode < 60) {
        litLen = lenCode + 1;
      } else {
        const bytes = lenCode - 59;
        litLen = 1;
        let mult = 1;
        for (let i = 0; i < bytes; i += 1) {
          if (pos + i >= input.length) throw new Error("literal length overflow");
          litLen += input[pos + i]! * mult;
          mult *= 256;
        }
        pos += bytes;
      }
      if (pos + litLen > input.length || written + litLen > out.length) throw new Error("literal overflow");
      input.copy(out, written, pos, pos + litLen);
      pos += litLen;
      written += litLen;
    } else if (type === 1) {
      if (pos >= input.length) throw new Error("copy overflow");
      const length = 4 + ((tag >> 2) & 0x7);
      const offset = ((tag >> 5) << 8) | input[pos]!;
      pos += 1;
      if (offset === 0 || offset > written || written + length > out.length) throw new Error("bad copy 1");
      for (let i = 0; i < length; i += 1) out[written + i] = out[written - offset + i]!;
      written += length;
    } else if (type === 2) {
      if (pos + 2 > input.length) throw new Error("copy overflow");
      const length = 1 + (tag >> 2);
      const offset = input[pos]! | (input[pos + 1]! << 8);
      pos += 2;
      if (offset === 0 || offset > written || written + length > out.length) throw new Error("bad copy 2");
      for (let i = 0; i < length; i += 1) out[written + i] = out[written - offset + i]!;
      written += length;
    } else {
      if (pos + 4 > input.length) throw new Error("copy overflow");
      const length = 1 + (tag >> 2);
      const offset = input.readUInt32LE(pos);
      pos += 4;
      if (offset === 0 || offset > written || written + length > out.length) throw new Error("bad copy 4");
      for (let i = 0; i < length; i += 1) out[written + i] = out[written - offset + i]!;
      written += length;
    }
  }
  if (written !== out.length) throw new Error(`snappy length mismatch ${written} != ${out.length}`);
  return out;
}

/**
 * Parse one block's entry list: [shared][non_shared][value_len][key][value].
 * Chromium's fork appends an 8-byte InternalKey tail ([type][seq]) to every
 * key and prefixes every value with a 1-byte type marker — both are stripped
 * here (stripSuffix strips the key tail; the value marker is stripped by the
 * caller).
 */
function parseBlockEntries(data: Buffer): RawEntry[] {
  const entries: RawEntry[] = [];
  if (data.length < 8) return entries;
  const count = data.readUInt32LE(data.length - 4);
  const restartBytes = 4 + 4 * count;
  if (restartBytes > data.length || restartBytes < 4) return entries;
  const limit = data.length - restartBytes;
  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < limit) {
    const s = readVarint(data, pos);
    if (s.value < 0 || s.value > prevKey.length) return entries;
    const ns = readVarint(data, s.next);
    if (ns.value < 0) return entries;
    const vl = readVarint(data, ns.next);
    if (vl.value < 0) return entries;
    const keyStart = vl.next;
    const keyEnd = keyStart + ns.value;
    const valueEnd = keyEnd + vl.value;
    if (valueEnd > limit) return entries;
    const key = Buffer.concat([prevKey.subarray(0, s.value), data.subarray(keyStart, keyEnd)]);
    entries.push({ key, value: data.subarray(keyEnd, valueEnd) });
    prevKey = key;
    pos = valueEnd;
  }
  return entries;
}

function readBlockAt(fileBuf: Buffer, offset: number, size: number): Buffer {
  if (offset < 0 || size < 0 || offset + size + 5 > fileBuf.length) throw new Error("block out of range");
  const data = fileBuf.subarray(offset, offset + size);
  const compression = fileBuf[offset + size]!;
  if (compression === 1) return snappyUncompress(data);
  if (compression === 0) return data;
  throw new Error(`unknown block compression ${compression}`);
}

function decodeInternalEntry(entry: RawEntry): LevelDbRecord | null {
  if (entry.key.length < 8) return null;
  const tag = entry.key.readBigUInt64LE(entry.key.length - 8);
  const type = Number(tag & 0xffn);
  if (type !== 0 && type !== 1) return null;
  return {
    key: Buffer.from(entry.key.subarray(0, entry.key.length - 8)),
    ...(type === 1 ? { value: Buffer.from(entry.value) } : {}),
    sequence: tag >> 8n,
    deleted: type === 0
  };
}

/** Parse all sequence-bearing value/deletion records stored in one SSTable. */
export function parseLevelDbSSTable(fileBuf: Buffer): LevelDbRecord[] {
  if (fileBuf.length < 48) return [];
  if (fileBuf.readBigUInt64LE(fileBuf.length - 8) !== 0xdb4775248b80fb57n) return [];
  let pos = fileBuf.length - 48;
  const metaOffset = readVarint(fileBuf, pos); pos = metaOffset.next;
  const metaSize = readVarint(fileBuf, pos); pos = metaSize.next;
  const ix = readVarint(fileBuf, pos);
  pos = ix.next;
  const ixSize = readVarint(fileBuf, pos);
  if (metaOffset.value < 0 || metaSize.value < 0 || ix.value < 0 || ixSize.value < 0) return [];
  let indexData: Buffer;
  try { indexData = readBlockAt(fileBuf, ix.value, ixSize.value); } catch { return []; }
  const out: LevelDbRecord[] = [];
  for (const entry of parseBlockEntries(indexData)) {
    const off = readVarint(entry.value, 0);
    const size = readVarint(entry.value, off.next);
    if (off.value < 0 || size.value < 0) continue;
    let blockData: Buffer;
    try { blockData = readBlockAt(fileBuf, off.value, size.value); } catch { continue; }
    for (const e of parseBlockEntries(blockData)) {
      const decoded = decodeInternalEntry(e);
      if (decoded) out.push(decoded);
    }
  }
  return out;
}

function readLengthPrefixed(input: Buffer, pos: number): { value: Buffer; next: number } {
  const length = readVarint(input, pos);
  if (length.value < 0 || length.next + length.value > input.length) throw new Error("invalid length-prefixed slice");
  return { value: Buffer.from(input.subarray(length.next, length.next + length.value)), next: length.next + length.value };
}

/** Parse one LevelDB WriteBatch: fixed64 sequence, fixed32 count, typed records. */
export function parseLevelDbWriteBatch(batch: Buffer): LevelDbRecord[] {
  if (batch.length < 12) throw new Error("truncated WriteBatch header");
  const sequence = batch.readBigUInt64LE(0);
  const count = batch.readUInt32LE(8);
  const out: LevelDbRecord[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    if (pos >= batch.length) throw new Error("truncated WriteBatch record");
    const type = batch[pos++]!;
    if (type !== 0 && type !== 1) throw new Error("unsupported WriteBatch record type");
    const key = readLengthPrefixed(batch, pos); pos = key.next;
    if (type === 0) {
      out.push({ key: key.value, sequence: sequence + BigInt(index), deleted: true });
      continue;
    }
    const value = readLengthPrefixed(batch, pos); pos = value.next;
    out.push({ key: key.value, value: value.value, sequence: sequence + BigInt(index), deleted: false });
  }
  if (pos !== batch.length) throw new Error("WriteBatch trailing bytes");
  return out;
}

/** Reassemble FULL/FIRST/MIDDLE/LAST physical records and parse WriteBatches. */
export function parseLevelDbLog(fileBuf: Buffer): LevelDbRecord[] {
  const logical: Buffer[] = [];
  const BLOCK = 32768;
  const HEADER = 7;
  let fragments: Buffer[] | null = null;
  for (let blockStart = 0; blockStart < fileBuf.length; blockStart += BLOCK) {
    let pos = blockStart;
    const blockEnd = Math.min(blockStart + BLOCK, fileBuf.length);
    while (pos + HEADER <= blockEnd) {
      const len = fileBuf.readUInt16LE(pos + 4);
      const type = fileBuf[pos + 6]!;
      if (pos + HEADER + len > blockEnd) break;
      const payload = fileBuf.subarray(pos + HEADER, pos + HEADER + len);
      pos += HEADER + len;
      if (type === 0 && len === 0) { fragments = null; continue; }
      if (type === 1) { fragments = null; logical.push(Buffer.from(payload)); }
      else if (type === 2) fragments = [Buffer.from(payload)];
      else if (type === 3) { if (fragments) fragments.push(Buffer.from(payload)); }
      else if (type === 4) {
        if (fragments) { fragments.push(Buffer.from(payload)); logical.push(Buffer.concat(fragments)); }
        fragments = null;
      } else fragments = null;
    }
  }
  const out: LevelDbRecord[] = [];
  for (const batch of logical) {
    try { out.push(...parseLevelDbWriteBatch(batch)); } catch { /* one malformed batch must not hide later valid batches */ }
  }
  return out;
}

/** Resolve records by user key, honoring the highest sequence and tombstones. */
export function resolveLevelDbRecords(records: LevelDbRecord[]): Map<string, LevelDbRecord> {
  const resolved = new Map<string, LevelDbRecord>();
  for (const record of records) {
    const encoded = record.key.toString("base64");
    const current = resolved.get(encoded);
    if (!current || record.sequence >= current.sequence) resolved.set(encoded, record);
  }
  return resolved;
}

/**
 * Scan Edge and Chrome profiles for platform.deepseek.com session tokens
 * stored in localStorage. Candidates are newest-first and deduplicated so a
 * stale profile cannot prevent a later candidate from authenticating.
 */
export function readPlatformTokenCandidatesFromBrowsers(): PlatformTokenCandidate[] {
  if (process.platform !== "win32") return [];
  const roots: Array<{ source: "edge" | "chrome"; root: string }> = [
    { source: "edge", root: join(homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data") },
    { source: "chrome", root: join(homedir(), "AppData", "Local", "Google", "Chrome", "User Data") }
  ];
  const candidates: PlatformTokenCandidate[] = [];
  for (const { source, root } of roots) {
    let profiles: string[];
    try { profiles = readdirSync(root); } catch { continue; }
    for (const profile of profiles) {
      const dir = join(root, profile, "Local Storage", "leveldb");
      let files: string[];
      try { files = readdirSync(dir); } catch { continue; }
      const records: LevelDbRecord[] = [];
      for (const name of files.sort()) {
        if (!name.endsWith(".ldb") && !name.endsWith(".log")) continue;
        let buf: Buffer;
        try { buf = readFileSync(join(dir, name)); } catch { continue; }
        if (buf.length === 0) continue;
        let entries: LevelDbRecord[];
        try {
          entries = name.endsWith(".log") ? parseLevelDbLog(buf) : parseLevelDbSSTable(buf);
        } catch { continue; }
        records.push(...entries);
      }
      const resolved = resolveLevelDbRecords(records).get(Buffer.from(TOKEN_KEY, "utf8").toString("base64"));
      if (!resolved || resolved.deleted || !resolved.value) continue;
      const token = decodeTokenValue(resolved.value);
      if (token) candidates.push({ token, source, profile });
    }
  }
  return candidates;
}

export function readPlatformTokensFromBrowsers(): string[] {
  return [...new Set(readPlatformTokenCandidatesFromBrowsers().map((candidate) => candidate.token))];
}

/** Backwards-compatible helper for callers that only need the newest candidate. */
export function readPlatformTokenFromBrowsers(): string | null {
  return readPlatformTokensFromBrowsers()[0] ?? null;
}

/** Strip the value type marker and extract the token from its JSON envelope. */
function decodeTokenValue(value: Buffer): string | null {
  let raw = value;
  if (raw.length > 0 && raw[0]! < 0x20) raw = raw.subarray(1); // 1-byte type marker
  let text = raw.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const parsed = JSON.parse(text) as { value?: unknown };
    if (parsed && typeof parsed.value === "string" && parsed.value.length > 0) return parsed.value;
  } catch { /* fall through to raw */ }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Platform API client
// ---------------------------------------------------------------------------

export interface PlatformDay {
  date: string; // "YYYY-MM-DD" (UTC as reported by the platform)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  requests: number;
  models: Record<string, PlatformModelTotals>;
}

export interface PlatformModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  requests: number;
}

interface PlatformUsageItem { type?: unknown; amount?: unknown }
interface PlatformModelUsage { model?: unknown; usage?: PlatformUsageItem[] }
interface PlatformDayUsage { date?: unknown; data?: PlatformModelUsage[] }

function asNumber(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Fetch one month of official usage+cost for the given platform token and
 * aggregate it into daily buckets. Throws PlatformError with a stable code
 * so the route can map it to a friendly message.
 */
export async function fetchPlatformMonth(token: string, month: string): Promise<{ days: PlatformDay[]; currency: string }> {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new PlatformError("INVALID_MONTH", "月份格式应为 YYYY-MM");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const amountBody = await platformGet<AmountPayload>("/api/v0/usage/amount", { month: String(monthNumber), year: String(year) }, token);
  const costBody = await platformGet<CostPayload>("/api/v0/usage/cost", { month: String(monthNumber), year: String(year) }, token);

  assertAmountPayload(amountBody);
  assertCostPayload(costBody);
  const amountDays = extractDays(amountBody);
  const costDays = extractCostDays(costBody);
  const currency = costBody.data.biz_data[0]!.currency;

  const byDate = new Map<string, PlatformDay>();
  const apply = (day: PlatformDay) => {
    const existing = byDate.get(day.date);
    if (!existing) { byDate.set(day.date, day); return; }
    existing.inputTokens += day.inputTokens;
    existing.outputTokens += day.outputTokens;
    existing.cacheReadTokens += day.cacheReadTokens;
    existing.cost += day.cost;
    existing.requests += day.requests;
    for (const [model, totals] of Object.entries(day.models)) {
      const current = existing.models[model] ?? emptyModelTotals();
      mergeModelTotals(current, totals);
      existing.models[model] = current;
    }
  };
  for (const day of amountDays) apply(day);
  for (const day of costDays) apply(day);
  const today = new Date().toISOString().slice(0, 10);
  const days = [...byDate.values()]
    .filter((day) => day.date <= today && hasConsumption(day))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days, currency };
}

/** Authenticate one ephemeral browser session before any ledger mutation. */
export async function validatePlatformToken(token: string): Promise<void> {
  await platformGet<unknown>("/api/v0/users/get_user_summary", {}, token);
}

/** amount payload: { code, data: { biz_code, biz_data: { total, days } } } */
interface AmountPayload { data: { biz_data: { days: PlatformDayUsage[] } } }
/** cost payload: { code, data: { biz_code, biz_data: [{ currency, total, days }] } } */
interface CostPayload { data: { biz_data: Array<{ currency: string; days: PlatformDayUsage[] }> } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUsageDays(value: unknown): value is PlatformDayUsage[] {
  if (!Array.isArray(value)) return false;
  return value.every((day) => isRecord(day)
    && typeof day.date === "string"
    && Array.isArray(day.data)
    && day.data.every((model) => isRecord(model)
      && typeof model.model === "string"
      && model.model.length > 0
      && Array.isArray(model.usage)
      && model.usage.every((item) => isRecord(item)
        && typeof item.type === "string"
        && (typeof item.amount === "number" || typeof item.amount === "string")
        && Number.isFinite(typeof item.amount === "string" ? Number.parseFloat(item.amount) : item.amount)
        && Number(item.amount) >= 0)));
}

function schemaChanged(): never {
  throw new PlatformError("PLATFORM_SCHEMA_CHANGED", "DeepSeek 平台私有仪表盘接口结构已变更");
}

function assertAmountPayload(value: unknown): asserts value is AmountPayload {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.biz_data) || !validUsageDays(value.data.biz_data.days)) schemaChanged();
}

function assertCostPayload(value: unknown): asserts value is CostPayload {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.biz_data) || value.data.biz_data.length < 1) schemaChanged();
  for (const bucket of value.data.biz_data) {
    if (!isRecord(bucket) || typeof bucket.currency !== "string" || !validUsageDays(bucket.days)) schemaChanged();
  }
}

function emptyModelTotals(): PlatformModelTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, requests: 0 };
}

function mergeModelTotals(target: PlatformModelTotals, other: PlatformModelTotals): void {
  target.inputTokens += other.inputTokens;
  target.outputTokens += other.outputTokens;
  target.cacheReadTokens += other.cacheReadTokens;
  target.cost += other.cost;
  target.requests += other.requests;
}

function hasConsumption(day: PlatformDay): boolean {
  return day.inputTokens > 0 || day.outputTokens > 0 || day.cacheReadTokens > 0 || day.cost > 0 || day.requests > 0;
}

function extractDays(body: AmountPayload): PlatformDay[] {
  const out: PlatformDay[] = [];
  const days = body.data.biz_data.days;
  for (const raw of days) {
    const date = typeof raw.date === "string" ? raw.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day: PlatformDay = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, requests: 0, models: {} };
    for (const model of raw.data ?? []) {
      const modelName = typeof model.model === "string" && model.model.length > 0 ? model.model : "unknown";
      const totals = day.models[modelName] ?? emptyModelTotals();
      let sawCacheBreakdown = false;
      let promptFallback = 0;
      for (const item of model.usage ?? []) {
        const type = typeof item.type === "string" ? item.type.toUpperCase() : "";
        const amount = Math.floor(asNumber(item.amount));
        if (type === "PROMPT_CACHE_HIT_TOKEN") { totals.cacheReadTokens += amount; sawCacheBreakdown = true; }
        else if (type === "PROMPT_CACHE_MISS_TOKEN") { totals.inputTokens += amount; sawCacheBreakdown = true; }
        else if (type === "PROMPT_TOKEN") promptFallback += amount;
        else if (type === "RESPONSE_TOKEN") totals.outputTokens += amount;
        else if (type === "REQUEST") totals.requests += amount;
      }
      if (!sawCacheBreakdown) totals.inputTokens += promptFallback;
      day.models[modelName] = totals;
      day.inputTokens += totals.inputTokens;
      day.outputTokens += totals.outputTokens;
      day.cacheReadTokens += totals.cacheReadTokens;
      day.requests += totals.requests;
    }
    out.push(day);
  }
  return out;
}

/** cost payload: { code, data: { biz_code, biz_data: [{ currency, total, days }] } } */
function extractCostDays(body: CostPayload): PlatformDay[] {
  const out: PlatformDay[] = [];
  for (const bucket of body.data.biz_data) for (const raw of bucket.days) {
    const date = typeof raw.date === "string" ? raw.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day: PlatformDay = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, requests: 0, models: {} };
    for (const model of raw.data ?? []) {
      const modelName = typeof model.model === "string" && model.model.length > 0 ? model.model : "unknown";
      const totals = day.models[modelName] ?? emptyModelTotals();
      for (const item of model.usage ?? []) {
        const type = typeof item.type === "string" ? item.type.toUpperCase() : "";
        if (type !== "REQUEST") totals.cost += asNumber(item.amount);
      }
      day.models[modelName] = totals;
      day.cost += totals.cost;
    }
    out.push(day);
  }
  return out;
}

export class PlatformError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function platformGet<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS);
  try {
    const response = await fetch(`${PLATFORM_BASE}${path}?${query}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new PlatformError("PLATFORM_AUTH_FAILED", "平台登录已过期，请在浏览器重新登录后重试");
      throw new PlatformError("PLATFORM_API_ERROR", `平台接口 HTTP ${response.status}`);
    }
    const body = await response.json() as { code?: unknown; msg?: unknown; data?: { biz_code?: unknown; biz_data?: unknown } };
    const code = typeof body.code === "number" ? body.code : -1;
    const bizCode = typeof body.data?.biz_code === "number" ? body.data.biz_code : 0;
    if (code === 40002 || code === 40003 || bizCode === 40002 || bizCode === 40003) {
      throw new PlatformError("PLATFORM_AUTH_FAILED", "平台登录已过期，请在浏览器重新登录后重试");
    }
    if (code !== 0 || bizCode !== 0) {
      throw new PlatformError("PLATFORM_API_ERROR", `平台接口返回错误 code=${code} biz_code=${bizCode}`);
    }
    return body as T;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new PlatformError("PLATFORM_TIMEOUT", "平台接口响应超时");
    throw new PlatformError("PLATFORM_NETWORK_ERROR", "无法连接 DeepSeek 开放平台");
  } finally {
    clearTimeout(timer);
  }
}
