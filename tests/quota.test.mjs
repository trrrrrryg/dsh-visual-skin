import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UsageRecorder,
  apply,
  emptyDay,
  getUsageRecorder,
  mergeDays,
  resolvePriceTable,
  totalTokens
} from "../packages/dsh-plugin/dist/host/index.js";
import {
  fetchPlatformMonth,
  parseLevelDbLog,
  parseLevelDbWriteBatch,
  resolveLevelDbRecords,
  validatePlatformToken
} from "../packages/dsh-plugin/dist/host/platform-import.js";

const zeroModel = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0, requests: 0 });
const model = (values = {}) => ({ ...zeroModel(), ...values });
const day = (date, modelName, values = {}) => {
  const usage = model(values);
  return {
    date,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    cost: usage.cost,
    requests: usage.requests,
    models: { [modelName]: usage }
  };
};

function dateKey(value) { return value.toISOString().slice(0, 10); }
function monthKey(value) { return dateKey(value).slice(0, 7); }
function shiftUtcDays(value, amount) { const next = new Date(value); next.setUTCDate(next.getUTCDate() + amount); return next; }
function varint(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do { let byte = remaining & 0x7f; remaining >>>= 7; if (remaining) byte |= 0x80; bytes.push(byte); } while (remaining);
  return Buffer.from(bytes);
}
function writeBatch(sequence, records) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(BigInt(sequence), 0);
  header.writeUInt32LE(records.length, 8);
  const body = records.map((record) => {
    const key = Buffer.from(record.key);
    if (record.deleted) return Buffer.concat([Buffer.from([0]), varint(key.length), key]);
    const value = Buffer.from(record.value);
    return Buffer.concat([Buffer.from([1]), varint(key.length), key, varint(value.length), value]);
  });
  return Buffer.concat([header, ...body]);
}
function physicalRecord(type, payload) {
  const header = Buffer.alloc(7);
  header.writeUInt16LE(payload.length, 4);
  header[6] = type;
  return Buffer.concat([header, payload]);
}

test("LevelDB WAL parses FULL and FIRST/MIDDLE/LAST WriteBatches and resolves sequence tombstones", () => {
  const tokenKey = Buffer.from("_https://platform.deepseek.com\x00\x01userToken", "utf8");
  const deletedKey = Buffer.from("deleted-key");
  const oldValue = Buffer.from('\u0001{"value":"old-token"}');
  const currentValue = Buffer.from('\u0001{"value":"current-token"}');
  const full = writeBatch(5n, [
    { key: tokenKey, value: oldValue },
    { key: deletedKey, value: Buffer.from("old") }
  ]);
  const fragmented = writeBatch(20n, [
    { key: tokenKey, deleted: true },
    { key: tokenKey, value: currentValue },
    { key: deletedKey, deleted: true }
  ]);
  const firstCut = Math.floor(fragmented.length / 3);
  const secondCut = Math.floor(fragmented.length * 2 / 3);
  const log = Buffer.concat([
    physicalRecord(1, full),
    physicalRecord(2, fragmented.subarray(0, firstCut)),
    physicalRecord(3, fragmented.subarray(firstCut, secondCut)),
    physicalRecord(4, fragmented.subarray(secondCut))
  ]);

  assert.equal(parseLevelDbWriteBatch(full).length, 2);
  const parsed = parseLevelDbLog(log);
  assert.deepEqual(parsed.map((record) => [record.sequence, record.deleted]), [[5n, false], [6n, false], [20n, true], [21n, false], [22n, true]]);
  const resolved = resolveLevelDbRecords(parsed);
  const token = resolved.get(tokenKey.toString("base64"));
  assert.equal(token?.sequence, 21n);
  assert.equal(token?.deleted, false);
  assert.deepEqual(token?.value, currentValue, "the newest WAL value must survive an older tombstone and value");
  const deleted = resolved.get(deletedKey.toString("base64"));
  assert.equal(deleted?.sequence, 22n);
  assert.equal(deleted?.deleted, true, "the newest tombstone must suppress an older value");
});

test("multiple distinct platform tokens can each validate, while duplicate token strings remain deduplicable", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options?.headers?.authorization);
    return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: {} } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const candidates = ["token-a", "token-a", "token-b"];
    const unique = [...new Set(candidates)];
    await Promise.all(unique.map((token) => validatePlatformToken(token)));
    assert.deepEqual(unique, ["token-a", "token-b"]);
    assert.deepEqual(seen.sort(), ["Bearer token-a", "Bearer token-b"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("platform month parsing attributes models, avoids PROMPT_TOKEN double counting, and filters zero/future days", async () => {
  const now = new Date();
  const today = dateKey(now);
  const future = dateKey(shiftUtcDays(now, 1));
  const zero = dateKey(shiftUtcDays(now, -1));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), authorization: options?.headers?.authorization });
    const amount = String(url).includes("/amount?");
    const days = amount ? [
      { date: today, data: [
        { model: "deepseek-chat", usage: [
          { type: "PROMPT_TOKEN", amount: "100" },
          { type: "PROMPT_CACHE_HIT_TOKEN", amount: 40 },
          { type: "PROMPT_CACHE_MISS_TOKEN", amount: 60 },
          { type: "RESPONSE_TOKEN", amount: 25 },
          { type: "REQUEST", amount: 2 }
        ] },
        { model: "deepseek-reasoner", usage: [
          { type: "PROMPT_TOKEN", amount: 9 },
          { type: "RESPONSE_TOKEN", amount: 3 },
          { type: "REQUEST", amount: 1 }
        ] }
      ] },
      { date: zero, data: [{ model: "deepseek-chat", usage: [{ type: "PROMPT_TOKEN", amount: 0 }] }] },
      { date: future, data: [{ model: "deepseek-chat", usage: [{ type: "PROMPT_TOKEN", amount: 999 }] }] }
    ] : [
      { date: today, data: [
        { model: "deepseek-chat", usage: [{ type: "INPUT_COST", amount: "0.12" }, { type: "REQUEST", amount: 99 }] },
        { model: "deepseek-reasoner", usage: [{ type: "OUTPUT_COST", amount: 0.34 }] }
      ] },
      { date: future, data: [{ model: "deepseek-chat", usage: [{ type: "INPUT_COST", amount: 8 }] }] }
    ];
    const biz_data = amount ? { days } : [{ currency: "CNY", total: "0.46", days }];
    return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await fetchPlatformMonth("session-token", monthKey(now));
    assert.equal(result.currency, "CNY");
    assert.equal(result.days.length, 1, "zero-only and future days must be removed");
    const parsed = result.days[0];
    assert.equal(parsed.date, today);
    assert.deepEqual({ input: parsed.inputTokens, cache: parsed.cacheReadTokens, output: parsed.outputTokens, requests: parsed.requests, cost: parsed.cost }, { input: 69, cache: 40, output: 28, requests: 3, cost: 0.46 });
    assert.deepEqual(parsed.models["deepseek-chat"], { inputTokens: 60, outputTokens: 25, cacheReadTokens: 40, cost: 0.12, requests: 2 }, "PROMPT_TOKEN must be ignored when hit/miss breakdown exists");
    assert.deepEqual(parsed.models["deepseek-reasoner"], { inputTokens: 9, outputTokens: 3, cacheReadTokens: 0, cost: 0.34, requests: 1 }, "PROMPT_TOKEN is the fallback when cache breakdown is absent");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((entry) => entry.authorization === "Bearer session-token"));
  } finally { globalThis.fetch = originalFetch; }
});

test("UsageRecorder migrates v1 totals into v2 local/official buckets", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-migrate-"));
  const file = join(root, "usage.json");
  try {
    await writeFile(file, JSON.stringify({ version: 1, days: {
      "2026-06-01": { ...day("2026-06-01", "ignored", { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1, cost: 0.1, requests: 1 }), models: undefined },
      "2026-06-02": { ...day("2026-06-02", "ignored", { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cost: 0.2, requests: 2 }), models: undefined, official: true }
    } }));
    const recorder = new UsageRecorder(file);
    const days = recorder.daysForMonth("2026-06");
    assert.deepEqual(days.map((value) => [value.date, value.source, totalTokens(value)]), [["2026-06-01", "local", 16], ["2026-06-02", "official", 28]]);
    assert.deepEqual(days.map((value) => value.models.unknown), [
      model({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1, cost: 0.1, requests: 1 }),
      model({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cost: 0.2, requests: 2 })
    ]);
    await recorder.flush();
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.version, 2);
    assert.ok(persisted.days["2026-06-01"].local);
    assert.ok(persisted.days["2026-06-02"].official);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("official monthly replacement is idempotent, clears stale official values, and preserves local fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-replace-"));
  const file = join(root, "usage.json");
  try {
    await writeFile(file, JSON.stringify({ version: 2, officialMonths: {}, days: {
      "2026-07-01": { local: day("2026-07-01", "local-chat", { inputTokens: 7, requests: 1 }) },
      "2026-07-02": { local: day("2026-07-02", "local-chat", { inputTokens: 8, requests: 1 }) }
    } }));
    const recorder = new UsageRecorder(file);
    const first = [day("2026-07-01", "official-chat", { inputTokens: 100, cost: 1, requests: 2 }), day("2026-07-02", "official-reasoner", { outputTokens: 50, cost: 2, requests: 1 })];
    assert.equal(recorder.importMonth("2026-07", first, "2026-08-20T00:00:00.000Z", "CNY"), 2);
    assert.equal(recorder.importMonth("2026-07", [day("2026-07-01", "official-chat", { inputTokens: 11, cost: 0.11, requests: 1 })], "2026-08-20T01:00:00.000Z", "CNY"), 1);
    assert.deepEqual(recorder.daysForMonth("2026-07").map((value) => [value.date, value.source, totalTokens(value)]), [["2026-07-01", "official", 11], ["2026-07-02", "local", 8]]);
    assert.equal(recorder.syncInfo("2026-07", "2026-07").syncedAt, "2026-08-20T01:00:00.000Z");
    await recorder.flush();
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.days["2026-07-02"].official, undefined, "stale official day must be deleted on repeated monthly sync");
    assert.ok(persisted.days["2026-07-02"].local, "local bucket must survive official replacement");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed transactional month persistence leaves the in-memory store unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-transaction-"));
  const file = join(root, "usage.json");
  const displaced = join(root, "usage-before-failure.json");
  try {
    await writeFile(file, JSON.stringify({ version: 2, officialMonths: { "2026-07": { syncedAt: "2026-08-01T00:00:00.000Z", currency: "CNY" } }, days: {
      "2026-07-01": { official: day("2026-07-01", "old-model", { inputTokens: 10, cost: 0.1, requests: 1 }) }
    } }));
    const recorder = new UsageRecorder(file);
    const before = recorder.daysForMonth("2026-07");
    await rename(file, displaced);
    await mkdir(file);
    await assert.rejects(recorder.importMonthsBatch([{ month: "2026-07", syncedAt: "2026-08-20T00:00:00.000Z", currency: "CNY", days: [
      day("2026-07-02", "new-model", { inputTokens: 999, cost: 9, requests: 9 })
    ] }]));
    assert.deepEqual(recorder.daysForMonth("2026-07"), before, "a failed atomic rename must not publish the candidate snapshot to readers");
    await rm(file, { recursive: true, force: true });
    await rename(displaced, file);
    await recorder.flush();
    assert.deepEqual(new UsageRecorder(file).daysForMonth("2026-07"), before, "subsequent flush must retain the pre-transaction state");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("batch commit overlapping concurrent flushes leaves disk and memory on the imported snapshot without temp races", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-overlap-"));
  const file = join(root, "usage.json");
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await writeFile(file, JSON.stringify({ version: 2, officialMonths: {}, days: {
      "2026-08-01": { local: day("2026-08-01", "local-model", { inputTokens: 3, requests: 1 }) }
    } }));
    const recorder = new UsageRecorder(file);
    const importedDays = Array.from({ length: 20 }, (_, index) => day(`2026-08-${String(index + 1).padStart(2, "0")}`, index % 2 ? "deepseek-chat" : "deepseek-reasoner", {
      inputTokens: 100 + index,
      outputTokens: 20 + index,
      cacheReadTokens: index,
      cost: 0.01 * (index + 1),
      requests: index + 1
    }));
    const batch = recorder.importMonthsBatch([{ month: "2026-08", days: importedDays, syncedAt: "2026-08-20T12:00:00.000Z", currency: "CNY" }]);
    const flushA = recorder.flush();
    const flushB = recorder.flush();
    const [imported] = await Promise.all([batch, flushA, flushB]);
    assert.equal(imported, 20);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const memory = recorder.daysForMonth("2026-08");
    const disk = new UsageRecorder(file).daysForMonth("2026-08");
    assert.deepEqual(disk, memory, "the last completed write must match the committed in-memory snapshot");
    assert.equal(memory.length, 20);
    assert.equal(memory.every((value) => value.source === "official"), true);
    assert.deepEqual(new UsageRecorder(file).syncInfo("2026-08", "2026-08"), { syncedAt: "2026-08-20T12:00:00.000Z" });
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), [], "all competing atomic-write temporaries must be renamed or cleaned");
    assert.deepEqual(unhandled, [], "overlapping batch/flush completion must not emit unhandled rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("range aggregation combines per-model totals without mutating source days", () => {
  const chat = day("2026-06-01", "deepseek-chat", { inputTokens: 10, outputTokens: 2, cost: 0.1, requests: 1 });
  const reasoner = day("2026-07-01", "deepseek-reasoner", { inputTokens: 20, cacheReadTokens: 5, reasoningTokens: 7, cost: 0.3, requests: 2 });
  const total = mergeDays(mergeDays(emptyDay(""), chat), reasoner);
  assert.deepEqual({ tokens: totalTokens(total), cost: total.cost, requests: total.requests, reasoning: total.reasoningTokens }, { tokens: 37, cost: 0.4, requests: 3, reasoning: 7 });
  assert.deepEqual(Object.keys(total.models).sort(), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(chat.models["deepseek-chat"].inputTokens, 10);
});

test("usage routes enforce POST origin/content type/month bounds and preserve ledger after rejected import", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-route-"));
  const usageFile = join(root, "usage.json");
  const themeFile = join(root, "theme.json");
  await writeFile(themeFile, "{}");
  const now = new Date();
  const currentMonth = monthKey(now);
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousMonth = monthKey(previous);
  const officialDate = `${previousMonth}-01`;
  const seed = new UsageRecorder(usageFile);
  seed.record({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 }, "local-model", resolvePriceTable({}));
  seed.importMonth(previousMonth, [day(officialDate, "official-model", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cost: 0.5, requests: 2 })], new Date().toISOString(), "CNY");
  await seed.flush();

  const routes = new Map();
  let disposeEffect = () => {};
  const webServer = {
    register(definition) { routes.set(definition.path, definition.handler); return () => routes.delete(definition.path); },
    tapIndex() { return () => {}; }
  };
  const ctx = {
    inject(_services, callback) { callback({ webServer, effect(factory) { disposeEffect = factory(); } }); },
    on() { return () => {}; }
  };
  apply(ctx, { profile: "quota-test", themeFile, assetDir: root, controllerUrl: "http://127.0.0.1:9", pluginSecret: "x".repeat(32), usage: { file: usageFile } });
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://127.0.0.1").pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const before = await (await fetch(`${base}/dsh-skin/usage?from=${previousMonth}&to=${currentMonth}`)).json();
    assert.equal(before.source, "mixed");
    assert.equal(totalTokens(before.rangeTotal), 138);
    assert.deepEqual(Object.keys(before.models).sort(), ["local-model", "official-model"]);

    let response = await fetch(`${base}/dsh-skin/usage/import`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403, "missing Origin is not same-origin");
    response = await fetch(`${base}/dsh-skin/usage/import`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403, "cross-origin POST must be rejected");
    response = await fetch(`${base}/dsh-skin/usage/import`, { method: "POST", headers: { origin: base }, body: "{}" });
    assert.equal(response.status, 415, "same-origin POST must require JSON content type");
    response = await fetch(`${base}/dsh-skin/usage/import`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ scope: "all", fromMonth: "2023-12", toMonth: currentMonth }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_IMPORT_RANGE");
    response = await fetch(`${base}/dsh-skin/usage?from=${previousMonth}`);
    assert.equal(response.status, 400, "range endpoints require both from and to");
    response = await fetch(`${base}/dsh-skin/usage?from=${previousMonth}&to=${currentMonth}&month=${currentMonth}`);
    assert.equal(response.status, 400, "month and range parameters are mutually exclusive");

    const after = await (await fetch(`${base}/dsh-skin/usage?from=${previousMonth}&to=${currentMonth}`)).json();
    assert.deepEqual(after.rangeTotal, before.rangeTotal, "a rejected/failed import must retain prior month values");
  } finally {
    disposeEffect();
    await getUsageRecorder({ usage: { file: usageFile } }).flush();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("usage import rejects multiple deduplicated valid WAL tokens as PLATFORM_ACCOUNT_AMBIGUOUS", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-ambiguous-"));
  const fakeHome = join(root, "home");
  const usageFile = join(root, "usage.json");
  const themeFile = join(root, "theme.json");
  const tokenKey = Buffer.from("_https://platform.deepseek.com\x00\x01userToken", "utf8");
  const makeTokenLog = (token, sequence) => physicalRecord(1, writeBatch(sequence, [{ key: tokenKey, value: Buffer.from(`\u0001${JSON.stringify({ value: token })}`) }]));
  const edgeDb = join(fakeHome, "AppData", "Local", "Microsoft", "Edge", "User Data", "Default", "Local Storage", "leveldb");
  const chromeDb = join(fakeHome, "AppData", "Local", "Google", "Chrome", "User Data", "Profile 1", "Local Storage", "leveldb");
  await mkdir(edgeDb, { recursive: true });
  await mkdir(chromeDb, { recursive: true });
  await writeFile(join(edgeDb, "000001.log"), makeTokenLog("account-a", 10n));
  await writeFile(join(chromeDb, "000002.log"), makeTokenLog("account-b", 20n));
  await writeFile(usageFile, JSON.stringify({ version: 2, officialMonths: {}, days: {} }));
  await writeFile(themeFile, "{}");

  const routes = new Map();
  let disposeEffect = () => {};
  const webServer = {
    register(definition) { routes.set(definition.path, definition.handler); return () => routes.delete(definition.path); },
    tapIndex() { return () => {}; }
  };
  const ctx = {
    inject(_services, callback) { callback({ webServer, effect(factory) { disposeEffect = factory(); } }); },
    on() { return () => {}; }
  };
  apply(ctx, { profile: "ambiguous-test", themeFile, assetDir: root, controllerUrl: "http://127.0.0.1:9", pluginSecret: "z".repeat(32), usage: { file: usageFile } });
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://127.0.0.1").pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const originalHome = process.env.USERPROFILE;
  const originalFetch = globalThis.fetch;
  const validated = [];
  try {
    process.env.USERPROFILE = fakeHome;
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith("https://platform.deepseek.com/")) return originalFetch(url, options);
      validated.push(options?.headers?.authorization);
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: {} } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const response = await originalFetch(`${base}/dsh-skin/usage/import`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ month: monthKey(new Date()) }) });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error?.code, "PLATFORM_ACCOUNT_AMBIGUOUS");
    assert.deepEqual(validated.sort(), ["Bearer account-a", "Bearer account-b"]);
    assert.deepEqual(payload.succeededMonths, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalHome;
    await new Promise((resolve) => server.close(resolve));
    disposeEffect();
    await getUsageRecorder({ usage: { file: usageFile } }).flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("corrupt usage ledger starts safely, creates an exact backup, and exposes a GET warning without overwriting the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-corrupt-"));
  const usageFile = join(root, "usage.json");
  const themeFile = join(root, "theme.json");
  const corrupt = '{"version":2,"days":';
  await writeFile(usageFile, corrupt);
  await writeFile(themeFile, "{}");
  const routes = new Map();
  let disposeEffect = () => {};
  const webServer = {
    register(definition) { routes.set(definition.path, definition.handler); return () => routes.delete(definition.path); },
    tapIndex() { return () => {}; }
  };
  const ctx = {
    inject(_services, callback) { callback({ webServer, effect(factory) { disposeEffect = factory(); } }); },
    on() { return () => {}; }
  };
  assert.doesNotThrow(() => apply(ctx, { profile: "corrupt-test", themeFile, assetDir: root, controllerUrl: "http://127.0.0.1:9", pluginSecret: "y".repeat(32), usage: { file: usageFile } }));
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://127.0.0.1").pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/dsh-skin/usage`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.warning?.code, "USAGE_STORE_RECOVERED");
    assert.match(payload.warning?.backupFile ?? "", /^usage\.json\.corrupt-.+\.bak$/);
    const backupPath = join(root, payload.warning.backupFile);
    assert.equal(await readFile(backupPath, "utf8"), corrupt, "the backup must retain the exact corrupt bytes");
    assert.equal(await readFile(usageFile, "utf8"), corrupt, "startup and GET must not overwrite the corrupt source file");
    assert.equal((await readdir(root)).filter((name) => name.includes(".corrupt-")).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    disposeEffect();
    await getUsageRecorder({ usage: { file: usageFile } }).flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
