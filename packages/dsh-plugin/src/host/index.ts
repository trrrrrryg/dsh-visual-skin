import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, copyFileSync, createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { fetchPlatformMonth, PlatformError, readPlatformTokenCandidatesFromBrowsers, validatePlatformToken } from "./platform-import.js";

interface ThemeDocument { designId: string; revision: number; hash: string; theme: unknown }
interface PreviewSession extends ThemeDocument { expiresAt: string; sessionId?: string; generation?: number }
interface RenderReceipt { mode: "stable" | "preview"; designId: string; revision: number; hash: string; pluginInstanceId: string; clientInstanceId: string; sessionId?: string; generation?: number }

export interface UsagePrice { input?: number; cacheRead?: number; output?: number }
export interface UsageConfig { file?: string; prices?: Record<string, UsagePrice> }
export interface Config {
  profile?: string;
  themeFile?: string;
  assetDir?: string;
  controllerUrl?: string;
  pluginSecret?: string;
  previewSessionId?: string;
  controllerEntry?: string;
  dataDir?: string;
  usage?: UsageConfig;
}
export const inject = ["webServer"];
// Must match the Controller's bounded background-asset storage ceiling.
const MAX_BACKGROUND_ASSET_BYTES = 4 * 1024 * 1024;
const BALANCE_CACHE_TTL_MS = 30_000;
const BALANCE_TIMEOUT_MS = 8_000;
const BALANCE_API_KEY_ENV = "DEEPSEEK_API_KEY";
const BALANCE_BASE_URL = "https://api.deepseek.com";
const UPDATE_CHECK_TTL_MS = 30 * 60_000;
const UPDATE_OWNER = "trrrrrryg";
const UPDATE_REPO = "dsh-visual-skin";
const UPDATE_RELEASES_URL = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;
// Resolved once: the plugin package version is the canonical product version.
const PLUGIN_VERSION = readPackageVersion();
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    if (typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version)) return manifest.version;
  } catch {}
  return "0.0.0";
}

export interface BalancePayload {
  ok: boolean;
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
  isAvailable?: boolean;
  queriedAt?: string;
  cached?: boolean;
  error?: { code: string; message: string };
}

export interface UpdateStatus {
  ok: boolean;
  current: string;
  latest?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  notes?: string;
  cached?: boolean;
  checkedAt?: string;
  error?: { code: string; message: string };
}

/**
 * Per-day usage ledger. Every provider stream reports its exact token usage
 * through the `usage` chunk (`inputTokens`/`outputTokens` disjoint counts plus
 * optional cache reads and reasoning), so the token numbers are exact while
 * the monetary "额度" is a local estimate computed from a per-model price
 * table (CNY per 1M tokens). The ledger is persisted as JSON in the plugin
 * data dir and survives restarts.
 */
export interface DayUsage {
  date: string; // "YYYY-MM-DD" in local time
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number; // estimated CNY (local) or official CNY (imported)
  requests: number;
  models: Record<string, ModelUsage>;
  source?: "local" | "official";
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
  requests: number;
}
export interface UsageDayBuckets { local?: DayUsage; official?: DayUsage }
export interface UsageStore {
  version: 2;
  days: Record<string, UsageDayBuckets>;
  officialMonths: Record<string, { syncedAt: string; currency: string }>;
}
export interface OfficialMonthSnapshot {
  month: string;
  days: Array<Pick<DayUsage, "date" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cost" | "requests" | "models">>;
  syncedAt: string;
  currency: string;
}

// DeepSeek's published CNY pricing (per 1M tokens) as sensible defaults; any
// entry can be overridden through `config.usage.prices` and unknown models
// fall back to the `*` entry, so estimates stay configurable.
const DEFAULT_USAGE_PRICES: Record<string, Required<UsagePrice>> = {
  "deepseek-v4-flash": { input: 1, cacheRead: 0.2, output: 2 },
  "deepseek-v4-pro": { input: 2, cacheRead: 0.5, output: 8 },
  "deepseek-chat": { input: 1, cacheRead: 0.2, output: 2 },
  "deepseek-reasoner": { input: 2, cacheRead: 0.5, output: 8 },
  "*": { input: 1, cacheRead: 0.2, output: 2 }
};
const USAGE_STORE_VERSION = 2 as const;
const USAGE_WRITE_DEBOUNCE_MS = 2_000;

export function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
export function localMonthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function validMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}
function monthOrdinal(value: string): number {
  const [year, month] = value.split("-").map(Number);
  return year! * 12 + month! - 1;
}
function monthKeys(from: string, to: string, maximum: number): string[] | null {
  if (!validMonth(from) || !validMonth(to)) return null;
  const start = monthOrdinal(from), end = monthOrdinal(to);
  if (start > end || end - start + 1 > maximum) return null;
  const keys: string[] = [];
  for (let value = start; value <= end; value += 1) keys.push(`${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, "0")}`);
  return keys;
}
export function resolvePriceTable(config: Config): Record<string, Required<UsagePrice>> {
  const table: Record<string, Required<UsagePrice>> = {};
  for (const [model, price] of Object.entries(DEFAULT_USAGE_PRICES)) table[model] = { ...price };
  for (const [model, price] of Object.entries(config.usage?.prices ?? {})) {
    const base = table[model] ?? table["*"] ?? DEFAULT_USAGE_PRICES["*"]!;
    table[model] = {
      input: finiteNonNegative(price.input) ? price.input! : base.input,
      cacheRead: finiteNonNegative(price.cacheRead) ? price.cacheRead! : base.cacheRead,
      output: finiteNonNegative(price.output) ? price.output! : base.output
    };
  }
  return table;
}
function finiteNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function priceForModel(table: Record<string, Required<UsagePrice>>, model: string): Required<UsagePrice> {
  return table[model] ?? table["*"] ?? DEFAULT_USAGE_PRICES["*"]!;
}
/** Estimated CNY cost for one call's disjoint token counts. */
export function computeCost(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }, price: Required<UsagePrice>): number {
  const input = finiteNonNegative(usage.inputTokens) ? usage.inputTokens : 0;
  const output = finiteNonNegative(usage.outputTokens) ? usage.outputTokens : 0;
  const cacheRead = finiteNonNegative(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  return (input * price.input + cacheRead * price.cacheRead + output * price.output) / 1_000_000;
}
export function totalTokens(day: Pick<DayUsage, "inputTokens" | "outputTokens" | "cacheReadTokens">): number {
  return day.inputTokens + day.outputTokens + day.cacheReadTokens;
}
export function emptyDay(date: string): DayUsage {
  return { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0, requests: 0, models: {} };
}
export function mergeDays(target: DayUsage, other: DayUsage): DayUsage {
  target.inputTokens += other.inputTokens;
  target.outputTokens += other.outputTokens;
  target.cacheReadTokens += other.cacheReadTokens;
  target.reasoningTokens += other.reasoningTokens;
  target.cost += other.cost;
  target.requests += other.requests;
  for (const [model, usage] of Object.entries(other.models)) {
    const current = target.models[model] ?? emptyModelUsage();
    mergeModelUsage(current, usage);
    target.models[model] = current;
  }
  return target;
}

function emptyModelUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0, requests: 0 };
}
function mergeModelUsage(target: ModelUsage, other: ModelUsage): void {
  target.inputTokens += other.inputTokens;
  target.outputTokens += other.outputTokens;
  target.cacheReadTokens += other.cacheReadTokens;
  target.reasoningTokens += other.reasoningTokens;
  target.cost += other.cost;
  target.requests += other.requests;
}
function cloneDay(day: DayUsage, source?: "local" | "official"): DayUsage {
  return { ...day, models: Object.fromEntries(Object.entries(day.models).map(([model, usage]) => [model, { ...usage }])), ...(source ? { source } : {}) };
}
function hasUsage(day: DayUsage): boolean {
  return day.inputTokens > 0 || day.outputTokens > 0 || day.cacheReadTokens > 0 || day.reasoningTokens > 0 || day.cost > 0 || day.requests > 0;
}

/**
 * Process-scoped ledger singleton per usage file. Records are accumulated in
 * memory and persisted atomically on a short debounce so frequent LLM streams
 * never cause a write per chunk; the flush on dispose covers shutdown.
 */
export class UsageRecorder {
  readonly file: string;
  readonly loadWarning?: { code: "USAGE_STORE_RECOVERED"; backupFile?: string };
  private store: UsageStore;
  private migrationBackupNeeded: boolean;
  private recoveryWriteBlocked: boolean;
  private localRevision = 0;
  private batching = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private batchTail: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    const loaded = loadUsageStore(file);
    this.store = loaded.store;
    this.migrationBackupNeeded = loaded.migratedFromV1;
    this.recoveryWriteBlocked = loaded.recoveryWriteBlocked === true;
    if (loaded.loadWarning) this.loadWarning = loaded.loadWarning;
  }

  record(usage: { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; reasoningTokens?: unknown }, model: string, prices: Record<string, Required<UsagePrice>>): void {
    const input = finiteNonNegative(usage.inputTokens) ? usage.inputTokens : 0;
    const output = finiteNonNegative(usage.outputTokens) ? usage.outputTokens : 0;
    const cacheRead = finiteNonNegative(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
    const reasoning = finiteNonNegative(usage.reasoningTokens) ? usage.reasoningTokens : 0;
    if (input === 0 && output === 0 && cacheRead === 0) return;
    const date = localDateKey();
    const buckets = this.store.days[date] ?? {};
    const day = buckets.local ?? emptyDay(date);
    const modelName = model.trim() || "unknown";
    const modelUsage = day.models[modelName] ?? emptyModelUsage();
    const cost = computeCost({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead }, priceForModel(prices, modelName));
    day.inputTokens += input;
    day.outputTokens += output;
    day.cacheReadTokens += cacheRead;
    day.reasoningTokens += reasoning;
    day.cost += cost;
    day.requests += 1;
    modelUsage.inputTokens += input;
    modelUsage.outputTokens += output;
    modelUsage.cacheReadTokens += cacheRead;
    modelUsage.reasoningTokens += reasoning;
    modelUsage.cost += cost;
    modelUsage.requests += 1;
    day.models[modelName] = modelUsage;
    buckets.local = day;
    this.store.days[date] = buckets;
    this.localRevision += 1;
    this.scheduleWrite();
  }

  /** Days with recorded usage inside one "YYYY-MM" month, ascending. */
  daysForMonth(month: string): DayUsage[] {
    return this.daysForRange(month, month);
  }

  /** Effective days: an official snapshot wins for its date, otherwise local usage is returned. */
  daysForRange(fromMonth: string, toMonth: string): DayUsage[] {
    return Object.entries(this.store.days)
      .filter(([date]) => date.slice(0, 7) >= fromMonth && date.slice(0, 7) <= toMonth)
      .map(([, buckets]) => buckets.official ? cloneDay(buckets.official, "official") : buckets.local ? cloneDay(buckets.local, "local") : null)
      .filter((day): day is DayUsage => day !== null && hasUsage(day))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  syncInfo(fromMonth: string, toMonth: string): { syncedAt?: string } {
    const values = Object.entries(this.store.officialMonths)
      .filter(([month]) => month >= fromMonth && month <= toMonth)
      .map(([, info]) => info.syncedAt)
      .sort();
    return values.length > 0 ? { syncedAt: values[values.length - 1]! } : {};
  }

  /** Aggregate one day; a zero record is returned when the day has no data. */
  daySummary(date: string): DayUsage {
    const buckets = this.store.days[date];
    return buckets?.official ? cloneDay(buckets.official, "official") : buckets?.local ? cloneDay(buckets.local, "local") : emptyDay(date);
  }

  /**
   * Merge official Open Platform days into the ledger. The platform numbers
   * are authoritative (exact tokens and exact CNY cost), so each imported day
   * REPLACES any local estimate for the same date and is flagged `official`.
   */
  importMonth(month: string, days: Array<Pick<DayUsage, "date" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cost" | "requests" | "models">>, syncedAt: string, currency: string): number {
    const imported = applyOfficialMonth(this.store, { month, days, syncedAt, currency });
    this.scheduleWrite();
    return imported;
  }

  /** Persist all successful official months as one transaction, then publish them to readers. */
  async importMonthsBatch(snapshots: OfficialMonthSnapshot[]): Promise<number> {
    if (snapshots.length === 0) return 0;
    let imported = 0;
    const operation = async () => { imported = await this.commitMonthsBatch(snapshots); };
    const queued = this.batchTail.then(operation, operation);
    this.batchTail = queued.then(() => {}, () => {});
    await queued;
    return imported;
  }

  private async commitMonthsBatch(snapshots: OfficialMonthSnapshot[]): Promise<number> {
    this.cancelWrite();
    this.batching = true;
    let committed = false;
    try {
      for (;;) {
        const revision = this.localRevision;
        const next = cloneUsageStore(this.store);
        let imported = 0;
        for (const snapshot of snapshots) imported += applyOfficialMonth(next, snapshot);
        await this.enqueueWrite(() => this.writeStore(next));
        if (revision !== this.localRevision) continue;
        this.store = next;
        committed = true;
        return imported;
      }
    } finally {
      this.batching = false;
      if (!committed) this.scheduleWrite();
    }
  }

  /** Backwards-compatible single-month import entrypoint. */
  importDays(days: Array<Pick<DayUsage, "date" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cost" | "requests"> & { models?: Record<string, ModelUsage> }>): number {
    const byMonth = new Map<string, Array<Pick<DayUsage, "date" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cost" | "requests" | "models">>>();
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
      const model = day.models ?? { unknown: { inputTokens: day.inputTokens, outputTokens: day.outputTokens, cacheReadTokens: day.cacheReadTokens, reasoningTokens: 0, cost: day.cost, requests: day.requests } };
      const monthDays = byMonth.get(day.date.slice(0, 7)) ?? [];
      monthDays.push({ ...day, models: model });
      byMonth.set(day.date.slice(0, 7), monthDays);
    }
    const syncedAt = new Date().toISOString();
    let imported = 0;
    for (const [month, monthDays] of byMonth) imported += this.importMonth(month, monthDays, syncedAt, "CNY");
    return imported;
  }

  flush(): Promise<void> {
    this.cancelWrite();
    const pendingBatches = this.batchTail;
    return pendingBatches.then(() => this.persistNow());
  }

  private scheduleWrite(): void {
    if (this.batching) return;
    if (this.writeTimer !== undefined) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.persistNow().catch(() => {});
    }, USAGE_WRITE_DEBOUNCE_MS);
  }
  private cancelWrite(): void {
    if (this.writeTimer !== undefined) { clearTimeout(this.writeTimer); this.writeTimer = undefined; }
  }
  private persistNow(): Promise<void> {
    return this.enqueueWrite(() => this.writeStore(cloneUsageStore(this.store)));
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    const queued = this.writeTail.then(write, write);
    this.writeTail = queued.then(() => {}, () => {});
    return queued;
  }

  private async writeStore(store: UsageStore): Promise<void> {
    if (this.recoveryWriteBlocked) throw new Error("USAGE_STORE_RECOVERY_BACKUP_FAILED");
    await mkdir(dirname(this.file), { recursive: true });
    if (this.migrationBackupNeeded) await copyFile(this.file, `${this.file}.v1.bak`);
    const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tmp, JSON.stringify(store), "utf8");
      await rename(tmp, this.file);
      this.migrationBackupNeeded = false;
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function cloneUsageStore(store: UsageStore): UsageStore {
  return JSON.parse(JSON.stringify(store)) as UsageStore;
}

function applyOfficialMonth(store: UsageStore, snapshot: OfficialMonthSnapshot): number {
  const { month, days, syncedAt, currency } = snapshot;
  for (const [date, buckets] of Object.entries(store.days)) {
    if (!date.startsWith(`${month}-`) || !buckets.official) continue;
    delete buckets.official;
    if (!buckets.local) delete store.days[date];
  }
  let imported = 0;
  for (const day of days) {
    if (!day || !day.date.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    const official: DayUsage = { date: day.date, inputTokens: positiveInt(day.inputTokens), outputTokens: positiveInt(day.outputTokens), cacheReadTokens: positiveInt(day.cacheReadTokens), reasoningTokens: 0, cost: positiveNum(day.cost), requests: positiveInt(day.requests), models: normalizeModels(day.models) };
    if (!hasUsage(official)) continue;
    const buckets = store.days[day.date] ?? {};
    buckets.official = official;
    store.days[day.date] = buckets;
    imported += 1;
  }
  store.officialMonths[month] = { syncedAt, currency };
  return imported;
}

const usageRecorders = new Map<string, UsageRecorder>();
export function getUsageRecorder(config: Config): UsageRecorder {
  const file = config.usage?.file ?? join(config.dataDir ?? dshHomeForHost(), "dsh-skin-usage.json");
  let recorder = usageRecorders.get(file);
  if (!recorder) {
    recorder = new UsageRecorder(file);
    usageRecorders.set(file, recorder);
  }
  return recorder;
}
function loadUsageStore(file: string): { store: UsageStore; migratedFromV1: boolean; recoveryWriteBlocked?: boolean; loadWarning?: { code: "USAGE_STORE_RECOVERED"; backupFile?: string } } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.days)) throw new Error("USAGE_STORE_INVALID_SCHEMA");
    if (parsed.version === 1) {
      const days: Record<string, UsageDayBuckets> = {};
      for (const [date, value] of Object.entries(parsed.days)) {
        const day = normalizeStoredDay(date, value, false);
        const official = isRecord(value) && value.official === true;
        days[date] = official ? { official: day } : { local: day };
      }
      return { store: { version: USAGE_STORE_VERSION, days, officialMonths: {} }, migratedFromV1: true };
    }
    if (parsed.version !== USAGE_STORE_VERSION || !isRecord(parsed.officialMonths)) throw new Error("USAGE_STORE_INVALID_SCHEMA");
    const days: Record<string, UsageDayBuckets> = {};
    for (const [date, value] of Object.entries(parsed.days)) {
      if (!isRecord(value) || (value.local === undefined && value.official === undefined)) throw new Error("USAGE_STORE_INVALID_SCHEMA");
      days[date] = {
        ...(value.local !== undefined ? { local: normalizeStoredDay(date, value.local, true) } : {}),
        ...(value.official !== undefined ? { official: normalizeStoredDay(date, value.official, true) } : {})
      };
    }
    const officialMonths: UsageStore["officialMonths"] = {};
    for (const [month, value] of Object.entries(parsed.officialMonths)) {
      if (!validMonth(month) || !isRecord(value) || typeof value.syncedAt !== "string" || !Number.isFinite(Date.parse(value.syncedAt)) || typeof value.currency !== "string") throw new Error("USAGE_STORE_INVALID_SCHEMA");
      officialMonths[month] = { syncedAt: value.syncedAt, currency: value.currency };
    }
    return { store: { version: USAGE_STORE_VERSION, days, officialMonths }, migratedFromV1: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: { version: USAGE_STORE_VERSION, days: {}, officialMonths: {} }, migratedFromV1: false };
    const backupFile = backupCorruptUsageStore(file);
    return { store: { version: USAGE_STORE_VERSION, days: {}, officialMonths: {} }, migratedFromV1: false, recoveryWriteBlocked: !backupFile, loadWarning: { code: "USAGE_STORE_RECOVERED", ...(backupFile ? { backupFile } : {}) } };
  }
}

function backupCorruptUsageStore(file: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const backup = `${file}.corrupt-${stamp}${suffix === 0 ? "" : `-${suffix}`}.bak`;
    if (existsSync(backup)) continue;
    try {
      copyFileSync(file, backup, fsConstants.COPYFILE_EXCL);
      return basename(backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return undefined;
    }
  }
  return undefined;
}

function normalizeStoredDay(date: string, value: unknown, requireModels: boolean): DayUsage {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(value) || (typeof value.date === "string" && value.date !== date)) throw new Error("USAGE_STORE_INVALID_SCHEMA");
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "reasoningTokens", "cost", "requests"] as const) if (!finiteNonNegative(value[key])) throw new Error("USAGE_STORE_INVALID_SCHEMA");
  const models = requireModels ? normalizeModels(value.models, true) : { unknown: {
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    cacheReadTokens: value.cacheReadTokens as number,
    reasoningTokens: value.reasoningTokens as number,
    cost: value.cost as number,
    requests: value.requests as number
  } };
  return { date, inputTokens: value.inputTokens as number, outputTokens: value.outputTokens as number, cacheReadTokens: value.cacheReadTokens as number, reasoningTokens: value.reasoningTokens as number, cost: value.cost as number, requests: value.requests as number, models };
}
function normalizeModels(value: unknown, strict = false): Record<string, ModelUsage> {
  if (!isRecord(value)) {
    if (strict) throw new Error("USAGE_STORE_INVALID_SCHEMA");
    return {};
  }
  const out: Record<string, ModelUsage> = {};
  for (const [model, raw] of Object.entries(value)) {
    if (!model || !isRecord(raw)) {
      if (strict) throw new Error("USAGE_STORE_INVALID_SCHEMA");
      continue;
    }
    const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "reasoningTokens", "cost", "requests"] as const;
    if (strict && keys.some((key) => !finiteNonNegative(raw[key]))) throw new Error("USAGE_STORE_INVALID_SCHEMA");
    out[model] = { inputTokens: positiveNum(raw.inputTokens), outputTokens: positiveNum(raw.outputTokens), cacheReadTokens: positiveNum(raw.cacheReadTokens), reasoningTokens: positiveNum(raw.reasoningTokens), cost: positiveNum(raw.cost), requests: positiveNum(raw.requests) };
  }
  return out;
}
function positiveInt(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function positiveNum(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }

/**
 * Resolve the DeepSeek API key for the balance proxy. The value is read only
 * on the Host: an explicit override, then the conventional environment
 * variable, then the DSH credentials document. It is never returned to the
 * browser and never included in any error response.
 */
export function resolveBalanceApiKey(dshHome: string): string | null {
  const direct = process.env.DSH_SKIN_BALANCE_API_KEY;
  if (direct) return direct;
  const named = process.env[BALANCE_API_KEY_ENV];
  if (named) return named;
  return readCredentialsKey(join(dshHome, ".credentials.yaml"), BALANCE_API_KEY_ENV);
}

export function normalizeBalancePayload(value: unknown): { currency: string; total: string; granted: string; toppedUp: string; isAvailable: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { is_available?: unknown; balance_infos?: unknown };
  if (typeof body.is_available !== "boolean" || !Array.isArray(body.balance_infos)) return null;
  const first = body.balance_infos[0];
  if (!first || typeof first !== "object") return null;
  const info = first as { currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown };
  if (typeof info.total_balance !== "string") return null;
  return {
    currency: typeof info.currency === "string" ? info.currency : "CNY",
    total: info.total_balance,
    granted: typeof info.granted_balance === "string" ? info.granted_balance : "0",
    toppedUp: typeof info.topped_up_balance === "string" ? info.topped_up_balance : "0",
    isAvailable: body.is_available
  };
}

function readCredentialsKey(path: string, key: string): string | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const match = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(key)}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\r\\n]+)`).exec(text);
  if (!match) return null;
  let value = match[1]!.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  return value || null;
}

async function fetchBalance(apiKey: string): Promise<{ currency: string; total: string; granted: string; toppedUp: string; isAvailable: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BALANCE_BASE_URL}/user/balance`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`balance API HTTP ${response.status}`);
    const payload = normalizeBalancePayload(await response.json());
    if (!payload) throw new Error("balance API response is malformed");
    return payload;
  } finally { clearTimeout(timer); }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function dshHomeForHost(): string { return process.env.DSH_HOME || join(homedir(), ".dsh"); }

// Persistent skin base, injected through the official webServer.tapIndex seam
// (the same seam the built-in ui-theme uses for its boot theme). The base
// lives at the CSS level on `html body`, so DSH route transitions — which
// replace React subtrees but never the body — cannot remove or reload it. The
// Client layers remain the refinement layer (preview fidelity, exact
// geometry, region picker); this style is the always-on canvas underneath.
const MAX_PERSISTENT_STYLE_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^--dsw-[a-z0-9-]+$/;
const ASSET_ID_PATTERN = /^sha256-[0-9a-f]{64}$/;

export function buildPersistentSkinStyle(theme: unknown): string {
  const appearance = theme && typeof theme === "object" ? (theme as { appearance?: unknown }).appearance : undefined;
  if (!appearance || typeof appearance !== "object") return "";
  const view = appearance as { backdrop?: unknown; regions?: unknown; tokens?: unknown };
  const tokens = isRecord(view.tokens) ? view.tokens as Record<string, { light?: unknown; dark?: unknown }> : undefined;
  const regions = isRecord(view.regions)
    ? view.regions as { linked?: unknown; divider?: unknown; sidebar?: unknown; main?: unknown }
    : { linked: true, divider: false, sidebar: view.backdrop, main: view.backdrop };
  const linked = regions.linked !== false;
  const main = regions.main ?? view.backdrop;
  const sidebar = regions.sidebar ?? view.backdrop;
  const divider = regions.divider === true;
  const parts: string[] = [];
  for (const mode of ["light", "dark"] as const) {
    const lines: string[] = [];
    for (const [name, pair] of Object.entries(tokens ?? {})) {
      if (!TOKEN_PATTERN.test(name)) continue;
      const value = pair?.[mode];
      if (typeof value === "string" && value.length > 0 && value.length <= 64) lines.push(`  ${name}: ${value};`);
    }
    if (lines.length > 0) parts.push(`html body${mode === "dark" ? "[data-ds-dark-theme]" : ""} {\n${lines.join("\n")}\n}`);
  }
  if (linked) {
    const blur = clampNum(isRecord(main) ? main.blurPx : 0, 0, 40);
    const opacity = clampNum(isRecord(main) ? main.opacity : 1, 0, 1);
    const linkedCss = cssBackdrop(main);
    if (opacity >= 1 && blur === 0) {
      // Most robust: paint the backdrop directly on the body background. It
      // sits below every element and cannot disappear during route
      // transitions — no pseudo-element, no z-index, no fixed positioning for
      // a route transition transform to disturb.
      parts.push(`html body{${linkedCss};background-attachment:fixed!important}`);
    } else {
      // A blur or partial opacity needs its own layer (body filter/opacity
      // would leak onto the whole UI). This pseudo canvas remains only for
      // those themes; the zero-blur common case uses the body background.
      parts.push(`html body::before{content:"";position:fixed;inset:-${blur * 2}px;z-index:-1;pointer-events:none;${linkedCss};opacity:${opacity};${blur > 0 ? `filter:blur(${blur}px);` : ""}background-attachment:fixed}`);
    }
    parts.push(`html body .pI_x6G_sidebarCol,html body .pI_x6G_frame,html body .pI_x6G_centerCol{background:transparent!important}`);
    // The sidebar content root must stay transparent AND stacked above the
    // canvas on every route replacement. A stylesheet-level rule applies to
    // whatever element matches at any moment, so a replaced sidebar subtree
    // cannot briefly return to the native opaque panel or slide under the
    // backdrop layer (the Client re-applies the same treatment inline).
    parts.push(`html body .pI_x6G_sidebarCol .hHd-Xa_root{background:transparent!important;position:relative!important;z-index:1!important}`);
    parts.push(`html body .qDHVXG_fade{background:transparent!important}`);
    parts.push(`html body .pI_x6G_sidebarCol{border-right-color:transparent!important}`);
    // The divider is a stylesheet pseudo-element so it can never be detached
    // by a route transition (the Client's DOM decoration is now only a
    // fallback when the index seam is unavailable).
    if (divider) parts.push(...dividerRules());
    // The conversation mask is default-on for the main region and off only on
    // the hero (identified by its unique workspace row). This covers route
    // loading windows too: while a conversation is mounting there is no hero
    // row yet, so the mask stays applied instead of popping on after load.
    const mask = maskColor(main);
    if (mask) {
      parts.push(`html body .pI_x6G_centerCol{background-color:${mask}!important}`);
      parts.push(`html body:has(div.wSkVaW_heroWorkspaceRow) .pI_x6G_centerCol{background-color:transparent!important}`);
    }
  } else {
    const sidebarCss = cssBackdrop(sidebar);
    const mainCss = cssBackdrop(main);
    if (sidebarCss) parts.push(`html body .pI_x6G_sidebarCol{${sidebarCss};background-attachment:fixed!important}`);
    if (mainCss) parts.push(`html body .pI_x6G_centerCol{${mainCss};background-attachment:fixed!important}`);
    parts.push(`html body .pI_x6G_sidebarCol .hHd-Xa_root{background:transparent!important;position:relative!important;z-index:1!important}`);
    parts.push(`html body .qDHVXG_fade{background:transparent!important}`);
    if (divider) parts.push(...dividerRules());
    const mask = maskColor(main);
    if (mask) {
      parts.push(`html body .pI_x6G_centerCol{box-shadow:inset 0 0 0 9999px ${mask}!important}`);
      parts.push(`html body:has(div.wSkVaW_heroWorkspaceRow) .pI_x6G_centerCol{box-shadow:none!important}`);
    }
  }
  const style = parts.join("\n");
  return style.length > 0 && style.length <= MAX_PERSISTENT_STYLE_BYTES ? style : "";
}

export function injectPersistentSkinStyle(html: string, getActive: () => ThemeDocument | null): string {
  if (html.includes("dsh-skin-persistent")) return html;
  const active = getActive();
  const style = active ? buildPersistentSkinStyle(active.theme) : "";
  if (!style) return html;
  return html.replace("</head>", `<style id="dsh-skin-persistent">${style}</style></head>`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function clampNum(value: unknown, min: number, max: number): number { return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }
function cssColor(value: unknown): string | null { return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null; }
function alphaOf(hex: string, opacity: number): string {
  const a = Math.min(1, Math.max(0, opacity));
  let expanded = hex;
  if (expanded.length === 4) expanded = expanded.replace(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/, "#$1$1$2$2$3$3");
  const match = /^#([0-9a-fA-F]{6})$/.exec(expanded);
  if (!match) return `rgb(0 0 0 / ${a})`;
  const n = Number.parseInt(match[1]!, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
}
function maskColor(backdrop: unknown): string | null {
  if (isRecord(backdrop) && backdrop.kind === "image") {
    const overlay = isRecord(backdrop.overlay) ? cssColor(backdrop.overlay.color) : null;
    return overlay ? alphaOf(overlay, 0.7) : "rgb(0 0 0 / 0.7)";
  }
  return "rgb(0 0 0 / 0.7)";
}
function dividerRules(): string[] {
  return [
    // A pseudo-element becomes a sibling stacking layer of DSH's settings
    // portal.  On rc.6 it can therefore paint *over* the dialog even though
    // the dialog itself has a large local z-index.  Draw the line as part of
    // the sidebar box instead: borders and inset shadows are painted beneath
    // descendants, so every native dialog and popover stays unobstructed.
    `html body .pI_x6G_sidebarCol{position:relative!important;border-right:1px solid rgb(230 248 255 / 76%)!important;box-shadow:inset -1px 0 7px rgb(89 192 255 / 26%)!important}`
  ];
}
function cssBackdrop(backdrop: unknown): string {
  if (!isRecord(backdrop)) return "";
  if (backdrop.kind === "image" && typeof backdrop.assetId === "string" && ASSET_ID_PATTERN.test(backdrop.assetId)) {
    const fit = backdrop.fit === "contain" ? "contain" : backdrop.fit === "fill" ? "100% 100%" : "cover";
    const position = isRecord(backdrop.position) ? backdrop.position : {};
    const x = clampNum(position.xPercent, 0, 100);
    const y = clampNum(position.yPercent, 0, 100);
    const overlayRecord = isRecord(backdrop.overlay) ? backdrop.overlay : undefined;
    const overlay = cssColor(overlayRecord?.color);
    const overlayOpacity = clampNum(overlayRecord?.opacity, 0, 1);
    const image = `url("/dsh-skin/assets/${backdrop.assetId}")`;
    return `background-image:${overlay ? `linear-gradient(${alphaOf(overlay, overlayOpacity)}, ${alphaOf(overlay, overlayOpacity)}), ` : ""}${image};background-size:${fit};background-position:${x}% ${y}%;background-repeat:no-repeat`;
  }
  const colors = Array.isArray(backdrop.colors) ? (backdrop.colors as unknown[]).filter((c): c is string => cssColor(c) !== null).slice(0, 4) : [];
  if (colors.length === 0) return "";
  if (backdrop.kind === "linear-gradient") return `background-image:linear-gradient(${clampNum(backdrop.angle, 0, 360)}deg,${colors.join(",")})`;
  if (backdrop.kind === "radial-gradient") return `background-image:radial-gradient(circle at center,${colors.join(",")})`;
  return `background-image:${colors[0]}`;
}

/**
 * llm/stream waterfall wrapper: pass every chunk through untouched and record
 * the exact provider token usage the moment the `usage` chunk arrives (usage
 * always precedes finish, and an early consumer break cannot lose the sample).
 */
async function* wrapUsageStream(options: { model?: unknown }, stream: AsyncIterable<unknown>, recorder: UsageRecorder, prices: Record<string, Required<UsagePrice>>): AsyncIterable<unknown> {
  for await (const chunk of stream) {
    if (chunk && typeof chunk === "object" && (chunk as { type?: unknown }).type === "usage") {
      const usage = (chunk as { usage?: unknown }).usage;
      if (usage && typeof usage === "object") {
        recorder.record(usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; reasoningTokens?: unknown }, typeof options?.model === "string" ? options.model : "*", prices);
      }
    }
    yield chunk;
  }
}

/**
 * Register an `llm/stream` waterfall listener. The event name is declared by
 * @deepseek-ai/dsh-llm's module augmentation (not available to this plugin's
 * isolated build), so the cordis Context is narrowed to the minimal shape.
 */
function onLlmStream(ctx: Context, listener: (options: { model?: unknown }, next: () => unknown) => AsyncIterable<unknown>): void {
  (ctx as unknown as { on(name: "llm/stream", listener: (options: { model?: unknown }, next: () => unknown) => AsyncIterable<unknown>): unknown }).on("llm/stream", listener);
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(["webServer"], (httpCtx) => {
    if (typeof httpCtx.effect !== "function") throw new Error("dsh-skin-studio requires the rc.6 effect lifecycle");
    if (!isRc6WebServer(httpCtx.webServer)) throw new Error("dsh-skin-studio requires the rc.6 webServer route/disposer contract");
    if (!config.profile || !/^[a-zA-Z0-9_-]{1,40}$/.test(config.profile) || !config.themeFile || !config.assetDir || !isLoopback(config.controllerUrl) || !config.pluginSecret || config.pluginSecret.length < 32 || (config.previewSessionId !== undefined && !/^[0-9a-f-]{36}$/i.test(config.previewSessionId))) throw new Error("dsh-skin-studio config is incomplete or unsafe");
    httpCtx.effect(() => {
      const pluginInstanceId = randomUUID();
      const abort = new AbortController();
      let stable: ThemeDocument | null = null, preview: PreviewSession | null = null, controllerInstanceId = "";
      let balanceCache: { at: number; value: BalancePayload } | undefined;
      let updateCache: { at: number; value: UpdateStatus } | undefined;
      let updateBusy = false;
      // Per-day token/quota ledger: the llm/stream waterfall records exact
      // provider token usage once per call; cost is a configurable estimate.
      const usage = getUsageRecorder(config);
      const prices = resolvePriceTable(config);
      onLlmStream(ctx, (options, next) => wrapUsageStream(options, next() as AsyncIterable<unknown>, usage, prices));
      const acknowledge = async (receipt: RenderReceipt) => {
        if (!controllerInstanceId) throw new Error("controller instance is unavailable");
        if (config.previewSessionId) {
          if (receipt.mode !== "preview" || receipt.sessionId !== config.previewSessionId || !Number.isInteger(receipt.generation)) throw new Error("isolated preview receipt is incomplete");
          const { mode: _mode, ...isolatedReceipt } = receipt;
          const response = await fetch(`${config.controllerUrl}/api/v1/preview-sessions/${encodeURIComponent(config.previewSessionId)}/host/rendered`, { method: "POST", signal: abort.signal, headers: auth(config.pluginSecret!), body: JSON.stringify({ ...isolatedReceipt, sessionId: receipt.sessionId, generation: receipt.generation, controllerInstanceId }) });
          if (!response.ok) throw new Error(`isolated render acknowledgement failed: ${response.status}`);
          return;
        }
        const kind = receipt.mode === "preview" ? "preview" : "theme";
        const response = await fetch(`${config.controllerUrl}/api/v1/plugin/${kind}/ack`, { method: "POST", signal: abort.signal, headers: auth(config.pluginSecret!), body: JSON.stringify({ profile: config.profile, mode: receipt.mode, designId: receipt.designId, revision: receipt.revision, hash: receipt.hash, controllerInstanceId, pluginInstanceId, clientInstanceId: receipt.clientInstanceId }) });
        if (!response.ok) throw new Error(`controller render acknowledgement failed: ${response.status}`);
      };
      const disposers = [
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/studio", handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          if (!config.controllerUrl) return json(res, 500, { error: "CONTROLLER_URL_MISSING" });
          // The Controller is a separate process that may have died (or was
          // never started after a reboot). If the installer recorded its
          // entry point, bring it back instead of failing with an unreachable
          // redirect — the settings card's "启动并打开 Skin Studio" must work
          // even after the Controller went away.
          if (!(await controllerAlive(config.controllerUrl))) {
            if (!config.controllerEntry || !config.dataDir) return json(res, 503, { error: "CONTROLLER_UNAVAILABLE", message: "Studio Controller 未运行，且缺少自动启动配置（请重跑 install.ps1）" });
            const started = await spawnController(config);
            if (!started) return json(res, 503, { error: "CONTROLLER_START_FAILED", message: "Studio Controller 启动失败，请查看日志后重试" });
          }
          res.writeHead(302, { location: config.controllerUrl, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end();
        } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/health", handler: (_req, res) => json(res, 200, { ok: true, plugin: "@dsh-skin/dsh-plugin", version: PLUGIN_VERSION, pluginInstanceId, mode: preview ? "preview" : "stable", designId: (preview ?? stable)?.designId ?? null, revision: (preview ?? stable)?.revision ?? null, hash: (preview ?? stable)?.hash ?? null }) }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/state", handler: async (_req, res) => { await refreshStable(); const active = preview ?? stable; if (!active) return json(res, 503, { error: "THEME_UNAVAILABLE" }); json(res, 200, { mode: preview ? "preview" : "stable", pluginInstanceId, ...active }); } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/theme", handler: async (_req, res) => { await refreshStable(); const active = preview ?? stable; if (!active) return json(res, 503, { error: "THEME_UNAVAILABLE" }); json(res, 200, active.theme); } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/rendered", handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!sameOrigin(req)) return json(res, 403, { error: "FORBIDDEN_ORIGIN" });
          try {
            const receipt = await renderReceipt(req);
            const mode = preview ? "preview" : "stable";
            const active = preview ?? stable;
            if (!active || receipt.mode !== mode || receipt.pluginInstanceId !== pluginInstanceId || receipt.designId !== active.designId || receipt.revision !== active.revision || receipt.hash !== active.hash) return json(res, 409, { error: "RENDER_STATE_MISMATCH" });
            await acknowledge(receipt);
            json(res, 202, { accepted: true });
          } catch (error) { json(res, 400, { error: "INVALID_RENDER_RECEIPT", message: error instanceof Error ? error.message : String(error) }); }
        } }),
        httpCtx.webServer.register({ kind: "prefix", path: "/dsh-skin/assets", handler: (req, res) => serveAsset(config.assetDir!, req, res) }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/balance", handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          const url = new URL(req.url || "/", "http://127.0.0.1");
          const refresh = url.searchParams.get("refresh") === "1";
          if (!refresh && balanceCache && Date.now() - balanceCache.at < BALANCE_CACHE_TTL_MS) {
            json(res, 200, { ...balanceCache.value, cached: true });
            return;
          }
          const apiKey = resolveBalanceApiKey(dshHomeForHost());
          if (!apiKey) return json(res, 200, { ok: false, error: { code: "BALANCE_KEY_UNAVAILABLE", message: "未找到 DeepSeek API 密钥（DEEPSEEK_API_KEY）" } });
          try {
            const value = await fetchBalance(apiKey);
            const payload: BalancePayload = { ok: true, ...value, queriedAt: new Date().toISOString(), cached: false };
            balanceCache = { at: Date.now(), value: payload };
            json(res, 200, payload);
          } catch (error) {
            json(res, 200, { ok: false, error: { code: "BALANCE_QUERY_FAILED", message: error instanceof Error ? error.name === "AbortError" ? "余额查询超时" : error.message.replace(/\s+/g, " ").slice(0, 120) : "余额查询失败" } });
          }
        } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/usage", handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          const url = new URL(req.url || "/", "http://127.0.0.1");
          const requestedMonth = url.searchParams.get("month");
          const requestedFrom = url.searchParams.get("from");
          const requestedTo = url.searchParams.get("to");
          if (requestedMonth && (requestedFrom || requestedTo)) return json(res, 400, { error: "AMBIGUOUS_USAGE_RANGE" });
          if ((requestedFrom && !requestedTo) || (!requestedFrom && requestedTo)) return json(res, 400, { error: "INVALID_USAGE_RANGE" });
          const from = requestedFrom ?? requestedMonth ?? localMonthKey();
          const to = requestedTo ?? requestedMonth ?? from;
          const months = monthKeys(from, to, 12);
          if (!months) return json(res, 400, { error: requestedMonth ? "INVALID_MONTH" : "INVALID_USAGE_RANGE" });
          const days = usage.daysForRange(from, to);
          const rangeTotal = days.reduce<DayUsage>((acc, day) => mergeDays(acc, day), emptyDay(""));
          const today = usage.daySummary(localDateKey());
          const sources = new Set(days.map((day) => day.source));
          const source: "local" | "official" | "mixed" = sources.has("official") && sources.has("local") ? "mixed" : sources.has("official") ? "official" : "local";
          const sync = usage.syncInfo(from, to);
          json(res, 200, {
            ok: true,
            month: requestedMonth ?? (from === to ? from : undefined),
            from,
            to,
            today,
            monthTotal: rangeTotal,
            rangeTotal,
            models: rangeTotal.models,
            days,
            source,
            estimated: source !== "official",
            ...sync,
            ...(usage.loadWarning ? { warning: usage.loadWarning } : {}),
            queriedAt: new Date().toISOString()
          });
        } }),
        // Import official usage from the platform's private dashboard API.
        // Session credentials are read ephemerally from local browser state;
        // they are never accepted from the client, persisted, logged or returned.
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/usage/import", handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          if (!sameOrigin(req)) return json(res, 403, { error: "FORBIDDEN_ORIGIN" });
          if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return json(res, 415, { ok: false, error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "请求体必须是 JSON" } });
          let body: Record<string, unknown> = {};
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += part.length;
              if (size > 16_384) throw new Error("body too large");
              chunks.push(part);
            }
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if (!isRecord(parsed)) throw new Error("body must be an object");
            body = parsed;
          } catch {
            return json(res, 400, { ok: false, error: { code: "INVALID_BODY", message: "请求体无效" } });
          }
          const allowed = new Set(["month", "scope", "fromMonth", "toMonth"]);
          if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { ok: false, error: { code: "INVALID_BODY", message: "请求体包含不支持的字段" } });
          if ((body.month !== undefined && (typeof body.month !== "string" || !validMonth(body.month)))
            || (body.fromMonth !== undefined && (typeof body.fromMonth !== "string" || !validMonth(body.fromMonth)))
            || (body.toMonth !== undefined && (typeof body.toMonth !== "string" || !validMonth(body.toMonth)))) return json(res, 400, { ok: false, error: { code: "INVALID_IMPORT_RANGE", message: "月份格式应为 YYYY-MM" } });
          const all = body.scope === "all";
          if (body.scope !== undefined && !all) return json(res, 400, { ok: false, error: { code: "INVALID_SCOPE", message: "scope 仅支持 all" } });
          if (all && body.month !== undefined) return json(res, 400, { ok: false, error: { code: "INVALID_BODY", message: "all 范围不能同时指定 month" } });
          if (!all && (body.fromMonth !== undefined || body.toMonth !== undefined)) return json(res, 400, { ok: false, error: { code: "INVALID_BODY", message: "fromMonth/toMonth 仅用于 all 范围" } });
          const currentMonth = localMonthKey();
          const from = all ? (typeof body.fromMonth === "string" ? body.fromMonth : "2024-01") : (typeof body.month === "string" ? body.month : currentMonth);
          const to = all ? (typeof body.toMonth === "string" ? body.toMonth : currentMonth) : from;
          const months = monthKeys(from, to, 60);
          if (!months || from < "2024-01" || to > currentMonth) return json(res, 400, { ok: false, error: { code: "INVALID_IMPORT_RANGE", message: "导入范围必须介于 2024-01 和当前月，且不超过 60 个月" } });
          let candidates: ReturnType<typeof readPlatformTokenCandidatesFromBrowsers> = [];
          try { candidates = readPlatformTokenCandidatesFromBrowsers(); } catch { candidates = []; }
          const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.token, candidate])).values()];
          if (uniqueCandidates.length === 0) return json(res, 200, { ok: false, partial: false, from, to, succeededMonths: [], failedMonths: months.map((month) => ({ month, code: "TOKEN_UNAVAILABLE", message: "未找到 DeepSeek 开放平台浏览器登录会话" })), importedDays: 0, error: { code: "TOKEN_UNAVAILABLE", message: "请在本机浏览器登录 platform.deepseek.com 后重试" }, queriedAt: new Date().toISOString() });
          const authentication = await Promise.all(uniqueCandidates.map(async (candidate) => {
            try { await validatePlatformToken(candidate.token); return { status: "valid" as const, token: candidate.token }; }
            catch (error) { return error instanceof PlatformError && error.code === "PLATFORM_AUTH_FAILED" ? { status: "invalid" as const } : { status: "unknown" as const }; }
          }));
          if (authentication.some((result) => result.status === "unknown")) return json(res, 200, { ok: false, partial: false, from, to, succeededMonths: [], failedMonths: months.map((month) => ({ month, code: "PLATFORM_ACCOUNT_VALIDATION_FAILED", message: "无法安全确认所有 DeepSeek 开放平台账号" })), importedDays: 0, error: { code: "PLATFORM_ACCOUNT_VALIDATION_FAILED", message: "平台账号验证失败，未写入用量账本" }, queriedAt: new Date().toISOString() });
          const validTokens = authentication.flatMap((result) => result.status === "valid" ? [result.token] : []);
          if (validTokens.length === 0) return json(res, 200, { ok: false, partial: false, from, to, succeededMonths: [], failedMonths: months.map((month) => ({ month, code: "PLATFORM_AUTH_FAILED", message: "DeepSeek 开放平台登录会话已失效" })), importedDays: 0, error: { code: "PLATFORM_AUTH_FAILED", message: "请在本机浏览器重新登录 platform.deepseek.com" }, queriedAt: new Date().toISOString() });
          if (validTokens.length > 1) return json(res, 409, { ok: false, partial: false, from, to, succeededMonths: [], failedMonths: months.map((month) => ({ month, code: "PLATFORM_ACCOUNT_AMBIGUOUS", message: "检测到多个有效 DeepSeek 开放平台账号" })), importedDays: 0, error: { code: "PLATFORM_ACCOUNT_AMBIGUOUS", message: "请仅保留一个已登录平台账号后重试" }, queriedAt: new Date().toISOString() });
          const authenticatedToken = validTokens[0]!;

          const succeeded: Array<{ month: string; importedDays: number; currency: string; cost: number; tokens: number; requests: number; snapshot: OfficialMonthSnapshot }> = [];
          const failedMonths: Array<{ month: string; code: string; message: string }> = [];
          let cursor = 0;
          const worker = async () => {
            for (;;) {
              const index = cursor++;
              const month = months[index];
              if (!month) return;
              let lastError: unknown;
              try {
                  const result = await fetchPlatformMonth(authenticatedToken, month);
                  const snapshot: OfficialMonthSnapshot = { month, syncedAt: new Date().toISOString(), currency: result.currency, days: result.days.map((day) => ({
                    ...day,
                    models: Object.fromEntries(Object.entries(day.models).map(([model, modelUsage]) => [model, { ...modelUsage, reasoningTokens: 0 }]))
                  })) };
                  const total = result.days.reduce((acc, day) => {
                    acc.cost += day.cost; acc.tokens += totalTokens(day); acc.requests += day.requests; return acc;
                  }, { cost: 0, tokens: 0, requests: 0 });
                  succeeded.push({ month, importedDays: result.days.length, currency: result.currency, snapshot, ...total });
              } catch (error) { lastError = error; }
              if (lastError) failedMonths.push({ month, code: lastError instanceof PlatformError ? lastError.code : "IMPORT_FAILED", message: lastError instanceof Error ? lastError.message.replace(/\s+/g, " ").slice(0, 160) : "导入失败" });
            }
          };
          await Promise.all(Array.from({ length: Math.min(3, months.length) }, () => worker()));
          succeeded.sort((a, b) => a.month.localeCompare(b.month));
          failedMonths.sort((a, b) => a.month.localeCompare(b.month));
          if (succeeded.length > 0) {
            try {
              const importedDays = await usage.importMonthsBatch(succeeded.map((item) => item.snapshot));
              if (importedDays !== succeeded.reduce((sum, item) => sum + item.importedDays, 0)) throw new Error("official snapshot validation mismatch");
            }
            catch { return json(res, 500, { ok: false, partial: false, from, to, succeededMonths: [], failedMonths: months.map((month) => ({ month, code: "USAGE_PERSIST_FAILED", message: "官方用量写入本地账本失败" })), importedDays: 0, error: { code: "USAGE_PERSIST_FAILED", message: "官方用量写入本地账本失败" }, queriedAt: new Date().toISOString() }); }
          }
          const totals = succeeded.reduce((acc, item) => { acc.importedDays += item.importedDays; acc.cost += item.cost; acc.tokens += item.tokens; acc.requests += item.requests; return acc; }, { importedDays: 0, cost: 0, tokens: 0, requests: 0 });
          const currencies = [...new Set(succeeded.map((item) => item.currency))];
          const ok = failedMonths.length === 0;
          json(res, 200, { ok, partial: succeeded.length > 0 && !ok, ...(all ? { scope: "all" as const } : { month: from }), from, to, succeededMonths: succeeded.map((item) => item.month), failedMonths, importedDays: totals.importedDays, currency: currencies.length === 1 ? currencies[0] : undefined, cost: totals.cost, tokens: totals.tokens, requests: totals.requests, queriedAt: new Date().toISOString() });
        } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/version", handler: async (_req, res) => {
          if (_req.method !== "GET") { res.writeHead(405, { allow: "GET", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(_req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          if (updateCache && Date.now() - updateCache.at < UPDATE_CHECK_TTL_MS) {
            json(res, 200, { ...updateCache.value, cached: true });
            return;
          }
          try {
            const status = await fetchLatestReleaseStatus();
            updateCache = { at: Date.now(), value: status };
            json(res, 200, status);
          } catch (error) {
            json(res, 200, { ok: false, current: PLUGIN_VERSION, error: { code: "UPDATE_CHECK_FAILED", message: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 120) : "版本检查失败" } });
          }
        } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/update", handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          if (updateBusy) return json(res, 409, { ok: false, error: { code: "UPDATE_IN_PROGRESS", message: "更新已在执行中" } });
          updateBusy = true;
          try {
            const status = await fetchLatestReleaseStatus();
            if (!status.ok || !status.latest || !status.updateAvailable || !status.downloadUrl) {
              json(res, 400, { ok: false, error: { code: "NOTHING_TO_UPDATE", message: "当前已是最新版本" } });
              return;
            }
            const result = await performUpdate(status);
            updateCache = { at: 0, value: await fetchLatestReleaseStatus() };
            json(res, 200, result);
          } catch (error) {
            json(res, 500, { ok: false, error: { code: "UPDATE_FAILED", message: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "更新失败" } });
          } finally {
            updateBusy = false;
          }
        } }),
        // The persistent skin base rides the same official index seam the
        // built-in ui-theme uses. Every served index.html gets a <style> that
        // pins the current theme onto `html body` (and per-region panels), so
        // route transitions can never blank or reload the background.
        httpCtx.webServer.tapIndex((html) => injectPersistentSkinStyle(html, () => preview ?? stable ?? readStableSync()))
      ];

      const refreshStable = async () => {
        try {
          const raw = await readFile(config.themeFile!, "utf8");
          const candidate = JSON.parse(raw) as ThemeDocument;
          if (!validDocument(candidate)) return;
          stable = candidate;
        } catch {}
      };
      // The index seam must paint the persistent base from the very first
      // request, before the first preview poll completes. The theme document
      // is small, so a synchronous fallback read is acceptable per request.
      const readStableSync = (): ThemeDocument | null => {
        try {
          const raw = readFileSync(config.themeFile!, "utf8");
          const candidate = JSON.parse(raw) as ThemeDocument;
          return validDocument(candidate) ? candidate : null;
        } catch { return null; }
      };
      const poll = async () => {
        try {
          await refreshStable();
          const endpoint = config.previewSessionId ? `${config.controllerUrl}/api/v1/preview-sessions/${encodeURIComponent(config.previewSessionId)}/host/state` : `${config.controllerUrl}/api/v1/plugin/preview?profile=${encodeURIComponent(config.profile!)}`;
          const response = await fetch(endpoint, { signal: abort.signal, headers: { authorization: `Bearer ${config.pluginSecret}` } });
          if (!response.ok) { preview = null; return; }
          const payload = await response.json() as { instanceId?: string; session?: PreviewSession | null };
          controllerInstanceId = typeof payload.instanceId === "string" ? payload.instanceId : "";
          const candidate = payload.session;
          if (!candidate || Date.parse(candidate.expiresAt) <= Date.now() || !validDocument(candidate) || (config.previewSessionId && (candidate.sessionId !== config.previewSessionId || !Number.isInteger(candidate.generation) || candidate.generation! < 1))) { preview = null; return; }
          preview = candidate;
        } catch { preview = null; }
      };
      void poll();
      const timer = setInterval(() => { void poll(); }, 800);
      return () => { clearInterval(timer); abort.abort(); preview = null; stable = null; void usage.flush().catch(() => {}); for (const dispose of disposers.reverse()) dispose(); };
    }, "dsh-skin-studio: rc.6 routes and preview poll");
  });
}

function isRc6WebServer(value: unknown): value is WebServer { return typeof value === "object" && value !== null && typeof (value as WebServer).register === "function"; }

function validDocument(value: ThemeDocument): boolean { return typeof value?.designId === "string" && Number.isInteger(value.revision) && value.revision > 0 && /^[0-9a-f]{64}$/.test(value.hash) && value.theme !== null && typeof value.theme === "object" && canonicalHash(value.theme) === value.hash; }
function canonicalHash(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`; return JSON.stringify(value); }
function auth(secret: string): Record<string, string> { return { authorization: `Bearer ${secret}`, "content-type": "application/json" }; }
function isLoopback(value: string | undefined): value is string { try { if (!value) return false; const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; } }
function isLoopbackHost(value: string | undefined): boolean { try { const hostname = new URL(`http://${value || ""}`).hostname; return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname); } catch { return false; } }
function sameOrigin(req: IncomingMessage): boolean { try { const origin = req.headers.origin; const host = req.headers.host; if (!origin || !host) return false; const parsed = new URL(origin); return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase() && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname); } catch { return false; } }
async function renderReceipt(req: IncomingMessage): Promise<RenderReceipt> {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new Error("content-type must be application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > 8_192) throw new Error("render receipt exceeds 8 KiB"); chunks.push(part); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<RenderReceipt>;
  if ((value.mode !== "stable" && value.mode !== "preview") || typeof value.designId !== "string" || !/^[0-9a-f-]{36}$/.test(value.designId) || !Number.isInteger(value.revision) || value.revision! <= 0 || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash) || typeof value.pluginInstanceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.pluginInstanceId) || typeof value.clientInstanceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.clientInstanceId) || (value.sessionId !== undefined && (!/^[0-9a-f-]{36}$/.test(value.sessionId) || !Number.isInteger(value.generation) || value.generation! < 1))) throw new Error("render receipt fields are invalid");
  return value as RenderReceipt;
}

async function serveAsset(assetDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD", "x-content-type-options": "nosniff" }); res.end(); return; }
  const id = new URL(req.url || "/", "http://127.0.0.1").pathname.slice("/dsh-skin/assets/".length);
  if (!/^sha256-[0-9a-f]{64}$/.test(id)) return json(res, 400, { error: "INVALID_ASSET_ID" });
  const root = resolve(assetDir);
  for (const [extension, mime] of [[".png", "image/png"], [".jpg", "image/jpeg"], [".webp", "image/webp"]] as const) {
    const path = resolve(root, `${id}${extension}`);
    if (dirname(path) !== root) return json(res, 400, { error: "INVALID_ASSET_PATH" });
    try { const info = await stat(path); if (!info.isFile() || info.size <= 0 || info.size > MAX_BACKGROUND_ASSET_BYTES) return json(res, 413, { error: "ASSET_INVALID" }); res.writeHead(200, { "content-type": mime, "content-length": info.size, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }); if (req.method === "HEAD") { res.end(); return; } createReadStream(path).pipe(res); return; } catch {}
  }
  json(res, 404, { error: "ASSET_NOT_FOUND" });
}
function json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); }

/**
 * Probe the Studio Controller. `/dsh-skin/health` is the DSH-side plugin
 * route when a preview host is up, while `/api/v1/status` is the Controller's
 * own endpoint — probe the latter since the settings card redirects there.
 */
/**
 * Probe the Studio Controller. `/dsh-skin/health` is the DSH-side plugin
 * route when a preview host is up, while `/api/v1/status` is the Controller's
 * own endpoint — probe the latter since the settings card redirects there.
 * Falls back to a raw TCP connect when the HTTP probe fails (the DSH host
 * process may route/block loopback fetches to other ports; a live socket on
 * the controller port is still proof it is up).
 */
async function controllerAlive(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/v1/status`, { method: "GET", signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    try {
      const url = new URL(base);
      const port = Number.parseInt(url.port, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
      const { connect } = await import("node:net");
      return await new Promise<boolean>((resolveProbe) => {
        const socket = connect({ host: url.hostname, port, timeout: 1_500 });
        const done = (alive: boolean) => { socket.destroy(); resolveProbe(alive); };
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
      });
    } catch { return false; }
  }
}

/**
 * Spawn the Controller process from the entry point the installer recorded,
 * then wait for it to become healthy. The child inherits DSH_HOME and is
 * given the same port/data-dir the rest of the integration uses; logs go to
 * %TEMP% so a failed start is diagnosable.
 */
async function spawnController(config: Config): Promise<boolean> {
  if (!config.controllerEntry || !config.controllerUrl || !config.dataDir) return false;
  try {
    const url = new URL(config.controllerUrl);
    const port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
    const { spawn } = await import("node:child_process");
    const log = join(process.env.TEMP || ".", "dsh-skin-controller.out.log");
    const errLog = join(process.env.TEMP || ".", "dsh-skin-controller.err.log");
    const child = spawn(process.execPath, [config.controllerEntry], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, DSH_SKIN_PORT: String(port), DSH_SKIN_DATA_DIR: config.dataDir }
    });
    child.unref();
    void logControllerOutput(child, log, errLog);
    // Give it up to 12s to boot (it links/installs the isolated runtime the
    // first time, which is the slowest path).
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await controllerAlive(config.controllerUrl)) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    }
    return await controllerAlive(config.controllerUrl);
  } catch { return false; }
}

/** Best-effort capture of the spawned Controller's stdout/stderr. */
async function logControllerOutput(child: import("node:child_process").ChildProcess, outLog: string, errLog: string): Promise<void> {
  try {
    const { createWriteStream } = await import("node:fs");
    if (child.stdout) child.stdout.pipe(createWriteStream(outLog, { flags: "a" }));
    if (child.stderr) child.stderr.pipe(createWriteStream(errLog, { flags: "a" }));
  } catch { /* logging must never break the spawn */ }
}

/** Compare dotted versions; returns true when `a` is newer than `b`. */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

/**
 * Query GitHub Releases for the latest release of this repository. The
 * tag must be a plain version (e.g. `v0.1.1`); prerelease tags are ignored
 * so the settings card only ever offers stable upgrades.
 */
async function fetchLatestReleaseStatus(): Promise<UpdateStatus> {
  const response = await fetch(UPDATE_RELEASES_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-visual-skin" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`GitHub 版本检查失败: HTTP ${response.status}`);
  const release = await response.json() as { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown };
  if (release.draft === true || release.prerelease === true) return { ok: true, current: PLUGIN_VERSION, updateAvailable: false, checkedAt: new Date().toISOString() };
  const tag = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/i, "") : "";
  if (!/^\d+\.\d+\.\d+/.test(tag)) return { ok: true, current: PLUGIN_VERSION, updateAvailable: false, checkedAt: new Date().toISOString() };
  const downloadUrl = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/archive/refs/tags/${encodeURIComponent(String(release.tag_name))}.zip`;
  return {
    ok: true,
    current: PLUGIN_VERSION,
    latest: tag,
    updateAvailable: isNewerVersion(tag, PLUGIN_VERSION),
    ...(typeof release.html_url === "string" ? { releaseUrl: release.html_url } : {}),
    downloadUrl,
    ...(typeof release.body === "string" ? { notes: release.body.slice(0, 500) } : {}),
    checkedAt: new Date().toISOString()
  };
}

/**
 * One-click update: download the tagged source archive, extract it, verify
 * the version manifest matches the release being installed, then replace the
 * installed skill's runtime and plugin dist with the freshly built ones.
 * Returns after the replacement is staged; DSH restart is left to the user.
 */
async function performUpdate(status: UpdateStatus): Promise<{ ok: true; updatedTo: string; staged: string[]; restartRequired: true }> {
  const latest = status.latest;
  const downloadUrl = status.downloadUrl;
  if (!latest || !downloadUrl) throw new Error("缺少更新信息");
  // The managed layout is <skill>/runtime/node_modules/@dsh-skin/controller/dist,
  // so the skill root sits four levels above this dist module.
  const here = dirname(fileURLToPath(import.meta.url));
  const skillRoot = resolve(here, "..", "..", "..", "..", "..");
  if (!(await exists(join(skillRoot, "SKILL.md")))) throw new Error("未找到已安装的 Skill（无法定位更新目标）");
  const work = join(tmpdir(), `dsh-skin-update-${latest}-${randomUUID().slice(0, 8)}`);
  await mkdir(work, { recursive: true });
  const zipPath = join(work, "release.zip");
  try {
    // 1. download (Web Streams body -> node write stream)
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`下载安装包失败: HTTP ${response.status}`);
    if (!response.body) throw new Error("下载内容为空");
    {
      const file = createWriteStream(zipPath);
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise<void>((resolveWrite, rejectWrite) => file.write(Buffer.from(value), (error) => (error ? rejectWrite(error) : resolveWrite())));
        }
      } finally {
        await new Promise<void>((resolveClose) => file.end(() => resolveClose()));
        reader.releaseLock();
      }
    }
    // 2. extract (Windows ships tar.exe which reads zip archives)
    await new Promise<void>((resolveExtract, rejectExtract) => {
      const child = spawn("tar", ["-xf", zipPath, "-C", work], { shell: false, windowsHide: true });
      child.on("error", rejectExtract);
      child.on("exit", (code) => (code === 0 ? resolveExtract() : rejectExtract(new Error(`解压失败: tar 退出码 ${code}`))));
    });
    // 3. locate the skill bundle inside the archive
    const entries = await readdirDeep(work);
    let skillCandidate: string | undefined;
    for (const entry of entries) {
      if (/[\\/]agents[\\/]codex-skill[\\/]deepseek-harness-skin-studio$/.test(entry) && await exists(join(entry, "SKILL.md"))) { skillCandidate = entry; break; }
    }
    if (!skillCandidate) throw new Error("安装包缺少 Skill 目录（agents/codex-skill/deepseek-harness-skin-studio）");
    // 4. verify the packaged runtime is built and version matches the release
    const packagedRuntime = join(skillCandidate, "runtime");
    if (!(await exists(join(packagedRuntime, "node_modules", "@dsh-skin", "controller", "dist", "index.js")))) throw new Error("安装包中的 runtime 未构建（请先运行 install.ps1 的构建步骤再发布）");
    const packagedPlugin = join(packagedRuntime, "plugin");
    if (!(await exists(join(packagedPlugin, "dist", "host", "index.js")))) throw new Error("安装包中的插件未构建");
    const packagedManifest = join(packagedRuntime, "node_modules", "@dsh-skin", "dsh-plugin", "package.json");
    if (await exists(packagedManifest)) {
      const manifest = JSON.parse(await readFile(packagedManifest, "utf8")) as { version?: string };
      if (manifest.version && manifest.version !== latest) throw new Error(`安装包版本 ${manifest.version} 与发布版本 ${latest} 不一致`);
    }
    // 5. stage replacement: swap runtime and plugin dist with backups
    const staged: string[] = [];
    const runtimeTarget = join(skillRoot, "runtime");
    const backup = join(tmpdir(), `dsh-skin-runtime-backup-${Date.now()}`);
    if (await exists(runtimeTarget)) {
      await rename(runtimeTarget, backup);
      staged.push("runtime");
    }
    try {
      await cp(packagedRuntime, runtimeTarget, { recursive: true });
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      // roll back on failure
      if (await exists(backup) && !(await exists(runtimeTarget))) await rename(backup, runtimeTarget);
      throw error;
    }
    // 6. restart the Controller so the new runtime serves the updated Studio
    const controllerEntry = join(runtimeTarget, "node_modules", "@dsh-skin", "controller", "dist", "index.js");
    if (await exists(controllerEntry)) {
      // Kill the process currently listening on the Controller port (if any).
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const out = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { timeout: 5_000, windowsHide: true });
        const line = out.stdout.split(/\r?\n/).find((row) => row.includes(":11862") && /LISTENING/i.test(row));
        const pid = line?.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) { try { await execFileAsync("taskkill", ["/F", "/PID", pid], { timeout: 5_000, windowsHide: true }); } catch {} }
      } catch {}
      const env = { ...process.env, DSH_SKIN_PORT: "11862", DSH_SKIN_DATA_DIR: join(process.env.LOCALAPPDATA || ".", "DeepSeekHarnessSkinStudio") };
      const child = spawn(process.execPath, [controllerEntry], { detached: true, stdio: "ignore", windowsHide: true, env });
      child.unref();
    }
    return { ok: true, updatedTo: latest, staged, restartRequired: true };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function readdirDeep(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      try { isDir = (await stat(full)).isDirectory(); } catch { continue; }
      if (isDir) stack.push(full);
      out.push(full);
    }
  }
  return out;
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
