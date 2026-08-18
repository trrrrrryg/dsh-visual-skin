import { spawn, type ChildProcess, execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppError, canonicalHash, DesignSessionCore } from "@dsh-skin/design-session-core";
import { ERROR_CODES, SUPPORTED_DSH_VERSION, type PreviewSessionStatus } from "@dsh-skin/shared";
import type { ThemeSpec } from "@dsh-skin/theme-schema";
import { installPlugin, writeActiveTheme, type ActiveThemeDocument, type DshTarget } from "./dsh.js";

const execFileAsync = promisify(execFile);
const TTL_MS = 5 * 60_000;
const UPDATE_COALESCE_MS = 180;
const WARM_RUNNER_LOCK = "isolated-preview-warm-runner";
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

interface SessionRecord extends PreviewSessionStatus {
  theme: ThemeSpec;
  secretHash: string;
  receipt?: { pluginInstanceId: string; clientInstanceId: string; at: string };
}
interface RenderReceipt { sessionId: string; generation: number; designId: string; revision: number; hash: string; pluginInstanceId: string; clientInstanceId: string; controllerInstanceId: string }
interface CleanupRecord { id: string; pid: number; port: number; bin: string; home: string; runtimeData: string; createdAt: string; processCreationDate: string }

/**
 * Runs a disposable DSH process which is owned by Controller. The persistent
 * session record deliberately contains only a secret hash. The raw secret is
 * held just long enough to configure the disposable Host and is never stored.
 */
export class PreviewRuntime {
  private readonly children = new Map<string, ChildProcess>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly sessionSecrets = new Map<string, string>();
  /** Only the latest edit is rendered; a single warm runner owns the write path. */
  private pendingUpdate: { designId: string; revision: number } | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  constructor(private readonly core: DesignSessionCore, private readonly options: { controllerUrl: () => string; controllerInstanceId: () => string; changed: (session: PreviewSessionStatus) => void }) {}

  async create(designId: string, revision: number): Promise<PreviewSessionStatus> {
    return this.core.withResourceLock(WARM_RUNNER_LOCK, async () => {
      const design = await this.requireDesign(designId, revision);
      const active = await this.reclaimAndListActive();
      const reusable = active.filter((session) => session.designId === designId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

      // A runner never changes designs in-place. Reap every other active
      // session before returning or provisioning, so a burst cannot fan out.
      for (const session of active) if (session.id !== reusable?.id) await this.stopWithinWarmLock(session.id);
      if (reusable) {
        this.clearQueuedUpdate();
        if (reusable.revision !== revision || reusable.hash !== canonicalHash(design.theme)) return this.updateWithinWarmLock(reusable.id, designId, revision);
        return this.public(await this.touch(reusable));
      }

      const now = new Date();
      const id = randomUUID();
      const operation = await this.core.startOperation("preview", `isolated:${id}:${designId}@${revision}`);
      const secret = randomBytes(32).toString("base64url");
      this.sessionSecrets.set(id, secret);
      const record: SessionRecord = {
        id, designId, revision, hash: canonicalHash(design.theme), generation: 1, theme: design.theme,
        secretHash: canonicalHash(secret), state: "provisioning", createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + TTL_MS).toISOString(), operationId: operation.id
      };
      await this.save(record);
      const pending = await this.core.transitionOperation(operation.id, "pending-verification", { expected: { profile: "isolated", designId, revision, hash: record.hash } });
      this.options.changed({ ...this.public(record), operationId: pending.id });
      // Provisioning takes the same lock before it writes to the temp home.
      // Concurrent creates therefore observe this record and reuse it.
      void this.provision(id);
      return this.public(record);
    });
  }

  /** Startup-only reconciliation of paths/PIDs that this Controller recorded. */
  async reconcile(): Promise<void> {
    for (const name of await this.core.store.list("isolated-preview-cleanup", ".json")) {
      const meta = await this.core.store.read<CleanupRecord>(`isolated-preview-cleanup/${name}`);
      if (!meta || !ownedCleanup(this.core.dataDir, meta)) continue;
      const terminated = await terminateRecordedChild(this.core.dataDir, meta);
      if (terminated) {
        await removeTempHome(meta.id); await removeSessionRuntimeData(this.core.dataDir, meta.id);
        await this.core.store.remove(`isolated-preview-cleanup/${meta.id}.json`);
      } else await this.core.store.remove(`isolated-preview-cleanup/${meta.id}.json`);
      try {
        const session = await this.getRecord(meta.id);
        if (!["stopped", "expired", "failed-safe"].includes(session.state)) {
          const failed: SessionRecord = { ...session, state: "failed-safe", error: { code: ERROR_CODES.unavailable, message: terminated ? "Controller restarted; isolated preview was cleaned up" : "Controller restarted; isolated preview cleanup could not prove process ownership" } };
          await this.save(failed);
          if (failed.operationId) await this.core.transitionOperation(failed.operationId, "failed-safe", { error: { code: ERROR_CODES.unavailable, message: failed.error!.message } });
        }
      } catch {}
    }
    for (const name of await this.core.store.list("isolated-preview-sessions", ".json")) {
      const session = await this.core.store.read<SessionRecord>(`isolated-preview-sessions/${name}`);
      if (session && !["stopped", "expired", "failed-safe"].includes(session.state)) await this.fail(session.id, ERROR_CODES.unavailable, "Controller restarted; isolated preview is not recoverable");
    }
  }

  async list(): Promise<PreviewSessionStatus[]> {
    const names = await this.core.store.list("isolated-preview-sessions", ".json");
    const all = await Promise.all(names.map((name) => this.core.store.read<SessionRecord>(`isolated-preview-sessions/${name}`)));
    const result: PreviewSessionStatus[] = [];
    for (const value of all) { if (value) result.push(this.public(await this.expireIfNeeded(value))); }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<PreviewSessionStatus> { return this.public(await this.expireIfNeeded(await this.getRecord(id))); }

  async update(id: string, designId: string, revision: number): Promise<PreviewSessionStatus> {
    return this.core.withResourceLock(WARM_RUNNER_LOCK, async () => {
      this.clearQueuedUpdate();
      return this.updateWithinWarmLock(id, designId, revision);
    });
  }

  async updateForDesign(designId: string, revision: number): Promise<void> {
    // Editing remains responsive: the PATCH response does not wait on I/O in
    // the disposable DSH. The timer is trailing, so sliders render only their
    // final revision and never queue stale writes.
    this.pendingUpdate = { designId, revision };
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      const pending = this.pendingUpdate;
      this.pendingUpdate = undefined;
      if (!pending) return;
      void this.core.withResourceLock(WARM_RUNNER_LOCK, async () => {
        const active = await this.reclaimAndListActive();
        const session = active.find((item) => item.designId === pending.designId);
        if (!session) return;
        try { await this.updateWithinWarmLock(session.id, pending.designId, pending.revision); }
        catch { /* A later edit or an explicit stop wins over a stale draft update. */ }
      }).catch(() => { /* Preview recovery is fail-safe and must not reject a design mutation. */ });
    }, UPDATE_COALESCE_MS);
  }

  async stop(id: string, expired = false): Promise<PreviewSessionStatus> {
    return this.core.withResourceLock(WARM_RUNNER_LOCK, async () => this.stopWithinWarmLock(id, expired));
  }

  async stopAll(): Promise<void> { for (const session of await this.list()) if (!["stopped", "expired", "failed-safe"].includes(session.state)) await this.stop(session.id); }
  activeDesignIds(): Promise<Set<string>> { return this.list().then((items) => new Set(items.filter((item) => !["stopped", "expired", "failed-safe"].includes(item.state)).map((item) => item.designId))); }

  async hostState(id: string, secret: string): Promise<{ instanceId: string; session: Record<string, unknown> | null }> {
    const session = await this.authenticate(id, secret);
    if (!["awaiting-render", "live", "updating"].includes(session.state) || Date.parse(session.expiresAt) <= Date.now()) return { instanceId: this.options.controllerInstanceId(), session: null };
    return { instanceId: this.options.controllerInstanceId(), session: { sessionId: session.id, generation: session.generation, designId: session.designId, revision: session.revision, hash: session.hash, theme: session.theme, expiresAt: session.expiresAt } };
  }

  async acknowledge(id: string, secret: string, receipt: RenderReceipt): Promise<PreviewSessionStatus> {
    // Receipt acceptance shares the warm runner lock with theme updates. An
    // acknowledgement captured for generation N can therefore never restore
    // a live receipt after generation N+1 was written.
    return this.core.withResourceLock(WARM_RUNNER_LOCK, async () => {
      const current = await this.authenticate(id, secret);
      if (receipt.controllerInstanceId !== this.options.controllerInstanceId() || receipt.sessionId !== current.id || receipt.generation !== current.generation || receipt.designId !== current.designId || receipt.revision !== current.revision || receipt.hash !== current.hash || !UUID.test(receipt.pluginInstanceId) || !UUID.test(receipt.clientInstanceId)) throw new AppError(ERROR_CODES.conflict, "Render acknowledgement does not match the isolated preview", 409);
      if (!["awaiting-render", "updating", "live"].includes(current.state) || Date.parse(current.expiresAt) <= Date.now()) throw new AppError(ERROR_CODES.conflict, "Preview acknowledgement is no longer active", 409);
      // A generation needs one proven render, not one receipt per open Studio
      // tab.  A second iframe/client can legitimately report the identical
      // already-rendered generation; rotating its receipt would invalidate a
      // safe-apply plan while the design itself has not changed.  Updates
      // explicitly clear both fields, so the next generation still requires a
      // fresh real render before it can be applied.
      if (current.state === "live" && current.renderReceiptHash && current.receipt) return this.public(current);
      const renderReceiptHash = canonicalHash({ sessionId: current.id, generation: current.generation, designId: current.designId, revision: current.revision, hash: current.hash, pluginInstanceId: receipt.pluginInstanceId, clientInstanceId: receipt.clientInstanceId });
      const live: SessionRecord = { ...current, state: "live", renderReceiptHash, receipt: { pluginInstanceId: receipt.pluginInstanceId, clientInstanceId: receipt.clientInstanceId, at: new Date().toISOString() } };
      await this.save(live);
      if (live.operationId) { const done = await this.core.transitionOperation(live.operationId, "succeeded", { expected: { profile: "isolated", designId: live.designId, revision: live.revision, hash: live.hash } }); this.options.changed({ ...this.public(live), operationId: done.id }); }
      else this.options.changed(this.public(live));
      return this.public(live);
    });
  }

  async requireLiveReceipt(id: string, generation: number, receiptHash: string, designId: string, revision: number, hash: string): Promise<PreviewSessionStatus> {
    const session = await this.getRecord(id);
    if (session.state !== "live" || session.generation !== generation || session.renderReceiptHash !== receiptHash || session.designId !== designId || session.revision !== revision || session.hash !== hash) throw new AppError(ERROR_CODES.conflict, "Apply requires the exact currently rendered isolated preview", 409);
    return this.public(session);
  }

  private async provision(id: string): Promise<void> {
    return this.core.withResourceLock(WARM_RUNNER_LOCK, async () => this.provisionWithinWarmLock(id));
  }

  private async provisionWithinWarmLock(id: string): Promise<void> {
    try {
      const current = await this.getRecord(id);
      if (current.state !== "provisioning") return;
      const secret = this.sessionSecrets.get(id);
      if (!secret) throw new AppError(ERROR_CODES.unavailable, "Isolated preview provisioning secret is unavailable; refusing recovery", 503);
      const runtime = await resolveRc6Bin();
      const target: DshTarget = { dshHome: tempHome(id), profile: "web" };
      await mkdir(target.dshHome, { recursive: true });
      await execRc6(runtime.bin, ["plugin", "--profile", "web", "list", "--depth", "0"], target.dshHome);
      await execRc6(runtime.bin, ["--profile", "web", "--dump-default-config"], target.dshHome);
      await linkRequiredRc6Packages(runtime.packageRoot, target.dshHome);
      await installPlugin(target, sessionDataDir(this.core.dataDir, id), this.options.controllerUrl(), secret, { previewSessionId: id, assetDir: join(this.core.dataDir, "assets", "content"), ephemeral: true });
      await this.writeSessionTheme(current);
      const port = await freePort();
      const child = spawn(process.execPath, [runtime.bin, "web", "--host", "127.0.0.1", "--port", String(port)], { cwd: target.dshHome, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, DSH_HOME: target.dshHome } });
      this.children.set(id, child);
      if (!child.pid) throw new AppError(ERROR_CODES.unavailable, "Isolated DSH did not return an owned process id", 503);
      const identity = await waitForWindowsProcessIdentity(child.pid);
      if (identity.kind !== "identity") throw new AppError(ERROR_CODES.unavailable, "Isolated DSH process identity could not be verified", 503);
      await this.core.store.write(`isolated-preview-cleanup/${id}.json`, { id, pid: child.pid, port, bin: runtime.bin, home: target.dshHome, runtimeData: sessionDataDir(this.core.dataDir, id), createdAt: new Date().toISOString(), processCreationDate: identity.creationDate } satisfies CleanupRecord);
      child.once("exit", () => { void this.fail(id, "CAPABILITY_UNAVAILABLE", "Isolated DSH exited before the preview was stopped"); });
      const next: SessionRecord = { ...current, state: "awaiting-host", url: `http://127.0.0.1:${port}` };
      await this.save(next); this.options.changed(this.public(next));
      this.sessionSecrets.delete(id);
      this.rearmExpiry(next);
      void this.awaitHost(id, next.url!);
    } catch (error) { await this.failWithinWarmLock(id, error instanceof AppError ? error.code : ERROR_CODES.unavailable, error instanceof Error ? error.message : String(error)); }
    finally { this.sessionSecrets.delete(id); }
  }

  private async awaitHost(id: string, url: string): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const active = await this.getRecord(id); if (active.state !== "awaiting-host") return;
      const expected = { generation: active.generation, designId: active.designId, revision: active.revision, hash: active.hash };
      try {
        const response = await fetch(`${url}/dsh-skin/health`, { signal: AbortSignal.timeout(750) });
        if (response.ok) {
          const advanced = await this.core.withResourceLock(WARM_RUNNER_LOCK, async () => {
            const current = await this.getRecord(id);
            if (current.state !== "awaiting-host" || current.generation !== expected.generation || current.designId !== expected.designId || current.revision !== expected.revision || current.hash !== expected.hash) return false;
            const awaiting: SessionRecord = { ...current, state: "awaiting-render" };
            await this.save(awaiting); this.options.changed(this.public(awaiting));
            return true;
          });
          // A newer update/stopping transition won the race. It owns the next
          // state and an old health probe must never overwrite it.
          if (advanced) return;
          return;
        }
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    await this.fail(id, ERROR_CODES.unavailable, "Isolated DSH did not expose the managed Host route");
  }

  private async writeSessionTheme(session: SessionRecord): Promise<void> {
    const target: DshTarget = { dshHome: tempHome(session.id), profile: "web" };
    const document: ActiveThemeDocument = { designId: session.designId, revision: session.revision, hash: session.hash, theme: session.theme };
    await writeActiveTheme(target, sessionDataDir(this.core.dataDir, session.id), document, { ephemeral: true });
  }
  /** Must be called while WARM_RUNNER_LOCK is held. */
  private async updateWithinWarmLock(id: string, designId: string, revision: number): Promise<PreviewSessionStatus> {
    const current = await this.getRecord(id);
    if (!["provisioning", "awaiting-host", "awaiting-render", "live", "updating"].includes(current.state)) throw new AppError(ERROR_CODES.conflict, "Preview session is not available for update", 409);
    const active = await this.reclaimAndListActive();
    if (!active.some((item) => item.id === id)) throw new AppError(ERROR_CODES.conflict, "Preview session is no longer the active warm runner", 409);
    for (const session of active) if (session.id !== id) await this.stopWithinWarmLock(session.id);
    const design = await this.requireDesign(designId, revision);
    const { renderReceiptHash: _renderReceiptHash, receipt: _receipt, error: _error, ...withoutReceipt } = current;
    const next: SessionRecord = {
      ...withoutReceipt,
      designId,
      revision,
      hash: canonicalHash(design.theme),
      theme: design.theme,
      generation: current.generation + 1,
      state: current.state === "provisioning" ? "provisioning" : "updating",
      expiresAt: this.nextExpiry()
    };
    await this.save(next); this.options.changed(this.public(next));
    if (next.state === "provisioning") return this.public(next);
    try { await this.writeSessionTheme(next); }
    catch (error) {
      await this.failWithinWarmLock(id, error instanceof AppError ? error.code : ERROR_CODES.unavailable, `Unable to write the isolated preview theme: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const awaiting: SessionRecord = { ...next, state: "awaiting-render" };
    await this.save(awaiting); this.options.changed(this.public(awaiting));
    this.rearmExpiry(awaiting);
    return this.public(awaiting);
  }

  /** Must be called while WARM_RUNNER_LOCK is held. */
  private async stopWithinWarmLock(id: string, expired = false): Promise<PreviewSessionStatus> {
    const current = await this.getRecord(id);
    if (["stopped", "expired", "failed-safe"].includes(current.state)) return this.public(current);
    const stopping: SessionRecord = { ...current, state: "stopping" }; await this.save(stopping); this.options.changed(this.public(stopping));
    await this.cleanupOwnedRuntime(id);
    const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id);
    this.sessionSecrets.delete(id);
    const done: SessionRecord = { ...stopping, state: expired ? "expired" : "stopped" }; await this.save(done); this.options.changed(this.public(done));
    return this.public(done);
  }

  /**
   * Enforce the one-runner invariant, including sessions created by an older
   * Controller version. Expired records are reaped before they can be reused.
   */
  private async reclaimAndListActive(): Promise<SessionRecord[]> {
    const records = await this.loadRecords();
    const active: SessionRecord[] = [];
    for (const record of records) {
      if (!isActive(record)) continue;
      if (Date.parse(record.expiresAt) <= Date.now()) {
        await this.stopWithinWarmLock(record.id, true);
        continue;
      }
      active.push(record);
    }
    return active.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async loadRecords(): Promise<SessionRecord[]> {
    const names = await this.core.store.list("isolated-preview-sessions", ".json");
    const records: SessionRecord[] = [];
    for (const name of names) {
      const record = await this.core.store.read<SessionRecord>(`isolated-preview-sessions/${name}`);
      if (record) records.push(record);
    }
    return records;
  }

  private nextExpiry(): string { return new Date(Date.now() + TTL_MS).toISOString(); }
  private async touch(record: SessionRecord): Promise<SessionRecord> {
    if (!isActive(record)) return record;
    const touched: SessionRecord = { ...record, expiresAt: this.nextExpiry() };
    await this.save(touched);
    this.rearmExpiry(touched);
    this.options.changed(this.public(touched));
    return touched;
  }
  private rearmExpiry(record: SessionRecord): void {
    const timer = this.timers.get(record.id); if (timer) clearTimeout(timer);
    this.timers.set(record.id, setTimeout(() => { void this.stop(record.id, true); }, Math.max(1, Date.parse(record.expiresAt) - Date.now())));
  }
  private clearQueuedUpdate(): void {
    this.pendingUpdate = undefined;
    if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = undefined; }
  }
  private async cleanupOwnedRuntime(id: string): Promise<void> {
    const child = this.children.get(id);
    if (child && !child.killed) {
      child.kill();
      await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000))]);
    } else {
      const meta = await this.core.store.read<CleanupRecord>(`isolated-preview-cleanup/${id}.json`);
      if (meta && (!ownedCleanup(this.core.dataDir, meta) || !await terminateRecordedChild(this.core.dataDir, meta))) throw new AppError(ERROR_CODES.unavailable, "Refusing to remove an unverified isolated preview process", 503);
    }
    this.children.delete(id);
    await removeTempHome(id);
    await removeSessionRuntimeData(this.core.dataDir, id);
    await this.core.store.remove(`isolated-preview-cleanup/${id}.json`);
  }
  private async requireDesign(id: string, revision: number) { const design = await this.core.getDesign(id); if (design.revision !== revision) throw new AppError(ERROR_CODES.conflict, "Preview revision is stale", 409, { expectedRevision: design.revision }); return design; }
  private async getRecord(id: string): Promise<SessionRecord> {
    if (!UUID.test(id)) throw new AppError(ERROR_CODES.notFound, "Preview session was not found", 404);
    const stored = await this.core.store.read<SessionRecord & { secret?: unknown }>(`isolated-preview-sessions/${id}.json`);
    if (!stored) throw new AppError(ERROR_CODES.notFound, "Preview session was not found", 404);
    if (typeof stored.secret === "string" || !/^[0-9a-f]{64}$/.test(stored.secretHash)) {
      const { secret: _legacySecret, ...safe } = stored;
      const failed: SessionRecord = { ...safe, secretHash: /^[0-9a-f]{64}$/.test(safe.secretHash) ? safe.secretHash : canonicalHash(randomUUID()), state: "failed-safe", error: { code: ERROR_CODES.unavailable, message: "Legacy preview secret was discarded; start a new isolated preview" } };
      await this.save(failed);
      return failed;
    }
    return stored;
  }
  private async expireIfNeeded(record: SessionRecord): Promise<SessionRecord> {
    if (!["stopped", "expired", "failed-safe"].includes(record.state) && Date.parse(record.expiresAt) <= Date.now()) { void this.stop(record.id, true); return { ...record, state: "expired" }; }
    return record;
  }
  private async authenticate(id: string, supplied: string): Promise<SessionRecord> { const record = await this.getRecord(id); const expected = Buffer.from(record.secretHash, "hex"), actual = Buffer.from(canonicalHash(supplied || ""), "hex"); if (!supplied || !timingSafeEqual(expected, actual)) throw new AppError(ERROR_CODES.confirmation, "Isolated preview Host authentication failed", 403); return record; }
  private async save(record: SessionRecord): Promise<void> { await this.core.store.write(`isolated-preview-sessions/${record.id}.json`, record); }
  private public(record: SessionRecord): PreviewSessionStatus { const { theme: _theme, secretHash: _secretHash, receipt: _receipt, ...safe } = record; return safe; }
  private async fail(id: string, code: string, message: string): Promise<void> { this.sessionSecrets.delete(id); try { await this.core.withResourceLock(WARM_RUNNER_LOCK, async () => this.failWithinWarmLock(id, code, message)); } catch {} }
  /** Must be called while WARM_RUNNER_LOCK is held. */
  private async failWithinWarmLock(id: string, code: string, message: string): Promise<void> {
    this.sessionSecrets.delete(id);
    const old = await this.getRecord(id);
    if (["stopped", "expired", "failed-safe"].includes(old.state)) return;
    const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id);
    let failure = message;
    try { await this.cleanupOwnedRuntime(id); } catch { failure = `${message}; owned runtime cleanup was not proven`; }
    const failed: SessionRecord = { ...old, state: "failed-safe", error: { code, message: failure } };
    await this.save(failed);
    if (old.operationId) await this.core.transitionOperation(old.operationId, "failed-safe", { error: { code, message: failure } });
    this.options.changed(this.public(failed));
  }
}

function tempHome(id: string): string { return join(tmpdir(), `dsh-skin-isolated-${id}.dsh`); }
function sessionDataDir(dataDir: string, id: string): string { return join(dataDir, "isolated-preview-runtime", id); }
function isActive(record: Pick<SessionRecord, "state">): boolean { return !["stopped", "expired", "failed-safe"].includes(record.state); }
async function removeTempHome(id: string): Promise<void> { const home = tempHome(id); const expected = resolve(tmpdir()).toLowerCase(); if (!resolve(home).toLowerCase().startsWith(`${expected}${process.platform === "win32" ? "\\" : "/"}dsh-skin-isolated-`)) throw new Error("refusing to remove non-isolated preview home"); await rm(home, { recursive: true, force: true }); }
async function removeSessionRuntimeData(dataDir: string, id: string): Promise<void> { const root = resolve(dataDir, "isolated-preview-runtime"); const target = resolve(root, id); if (!UUID.test(id) || !target.toLowerCase().startsWith(`${root.toLowerCase()}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("refusing to remove non-isolated preview runtime data"); await rm(target, { recursive: true, force: true }); }
function ownedCleanup(dataDir: string, value: CleanupRecord): boolean {
  return UUID.test(value.id) && Number.isInteger(value.pid) && value.pid > 0 && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && typeof value.bin === "string" && isAbsolute(value.bin) && resolve(value.home) === tempHome(value.id)
    && resolve(value.runtimeData) === sessionDataDir(dataDir, value.id) && validProcessCreationDate(value.processCreationDate);
}
async function terminateRecordedChild(dataDir: string, meta: CleanupRecord): Promise<boolean> {
  if (!ownedCleanup(dataDir, meta)) return false;
  const identity = await readWindowsProcessIdentity(meta.pid);
  if (identity.kind === "absent") return true; // no current process owns this PID, so temp paths are safe to remove
  if (identity.kind !== "identity") return false;
  if (identity.creationDate !== meta.processCreationDate || !await homeHasPreviewEvidence(meta)) return false;
  try {
    const command = identity.commandLine;
    const normalized = command.toLowerCase(), bin = resolve(meta.bin).toLowerCase();
    if (!normalized.includes(bin) || !/\bweb\b/.test(normalized) || !new RegExp(`--port\\s+${meta.port}(?:\\s|$)`).test(normalized)) return false;
    try { process.kill(meta.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; return false; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    return true;
  } catch { return false; }
}
type ProcessIdentityProbe = { kind: "absent" } | { kind: "unavailable" } | { kind: "identity"; creationDate: string; commandLine: string };
async function readWindowsProcessIdentity(pid: number): Promise<ProcessIdentityProbe> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return { kind: "unavailable" };
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  try {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p){[pscustomobject]@{CreationDate=$p.CreationDate;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}`;
    const { stdout } = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 3_000, maxBuffer: 16_384 });
    if (!stdout.trim()) return { kind: "absent" };
    const value = JSON.parse(stdout.trim()) as { CreationDate?: unknown; CommandLine?: unknown };
    if (typeof value.CreationDate !== "string" || !validProcessCreationDate(value.CreationDate) || typeof value.CommandLine !== "string") return { kind: "unavailable" };
    return { kind: "identity", creationDate: value.CreationDate, commandLine: value.CommandLine };
  } catch { return { kind: "unavailable" }; }
}
function validProcessCreationDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/.test(value) || /^\/Date\(\d+\)\/$/.test(value); }
async function waitForWindowsProcessIdentity(pid: number): Promise<ProcessIdentityProbe> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const identity = await readWindowsProcessIdentity(pid);
    if (identity.kind !== "absent") return identity;
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  return { kind: "unavailable" };
}
async function homeHasPreviewEvidence(meta: CleanupRecord): Promise<boolean> {
  try {
    const patch = await readFile(join(meta.home, "profiles", "web", "cordis.patch.yml"), "utf8");
    return patch.includes("# >>> dsh-skin-studio managed block >>>") && patch.includes(`previewSessionId: '${meta.id}'`);
  } catch { return false; }
}
async function freePort(): Promise<number> { const { createServer } = await import("node:net"); return new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolvePort(port)); }); }); }
async function resolveRc6Bin(): Promise<{ bin: string; packageRoot: string }> {
  const explicit = process.env.DSH_RC6_BIN;
  const candidates: string[] = [];
  if (explicit) { if (!resolve(explicit) || !requireAbsolute(explicit)) throw new AppError(ERROR_CODES.badRequest, "DSH_RC6_BIN must be a canonical absolute path", 400); candidates.push(explicit); }
  else for (const home of [process.env.DSH_PREVIEW_DSH_HOME, process.env.DSH_HOME, join(homedir(), ".dsh")]) if (home) candidates.push(join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  for (const candidate of candidates) try { if (!(await stat(candidate)).isFile()) continue; const packageRoot = resolve(candidate, "..", ".."); if (!await validRc6Package(packageRoot, "dsh")) continue; const { stdout } = await execFileAsync(process.execPath, [candidate, "--version"], { windowsHide: true, timeout: 8_000 }); if (stdout.includes(SUPPORTED_DSH_VERSION)) return { bin: resolve(candidate), packageRoot }; } catch {}
  throw new AppError(ERROR_CODES.unsupported, `No verified DSH ${SUPPORTED_DSH_VERSION} CLI is available for an isolated preview`, 409);
}
function requireAbsolute(value: string): boolean { return resolve(value) === value; }
async function execRc6(bin: string, argv: string[], home: string): Promise<void> { try { await execFileAsync(process.execPath, [bin, ...argv], { windowsHide: true, timeout: 20_000, env: { ...process.env, DSH_HOME: home } }); } catch (error) { throw new AppError(ERROR_CODES.unavailable, `Official rc.6 provisional setup failed: ${error instanceof Error ? error.message : String(error)}`, 503); } }
async function linkRequiredRc6Packages(sourcePackageRoot: string, home: string): Promise<void> {
  const targetScope = join(home, "profiles", "node_modules", "@deepseek-ai");
  await mkdir(targetScope, { recursive: true });
  const scopes = await discoverRc6Scopes(sourcePackageRoot);
  const packages = await collectRc6FamilyPackages(scopes);
  for (const name of REQUIRED_RC6_PACKAGES) if (!packages.has(name)) throw new AppError(ERROR_CODES.unavailable, `Verified rc.6 runtime package is missing: @deepseek-ai/${name}`, 503);
  // The rc.6 default web config loads a family of dsh-client/dsh-host modules
  // by package name. Link the verified rc.6 family, not just the first five
  // entry points, so a pnpm store layout behaves like a fully provisioned home.
  for (const [name, source] of packages) {
    const target = join(targetScope, name);
    if (await validRc6Package(target, name)) continue;
    try { await stat(target); throw new AppError(ERROR_CODES.unavailable, `Temporary DSH package is incompatible: @deepseek-ai/${name}`, 503); } catch (error) { if (error instanceof AppError) throw error; }
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  }
}

const REQUIRED_RC6_PACKAGES = ["dsh", "dsh-client-runtime", "dsh-client-ui-theme", "dsh-host-webserver", "dsh-host-frontend-static"] as const;

/** Discover only scopes reachable from the verified DSH package lineage. */
async function discoverRc6Scopes(sourcePackageRoot: string): Promise<string[]> {
  const scopes = new Set<string>();
  const addScope = async (candidate: string) => { try { if ((await stat(candidate)).isDirectory()) scopes.add(resolve(candidate)); } catch {} };
  await addScope(resolve(sourcePackageRoot, ".."));
  try { await addScope(resolve(await realpath(sourcePackageRoot), "..")); } catch {}
  const starts = [resolve(sourcePackageRoot), await safeRealpath(sourcePackageRoot)];
  for (const start of starts) {
    let cursor = start;
    for (let depth = 0; depth < 10; depth += 1) {
      const store = join(cursor, ".pnpm");
      try {
        const entries = await readdir(store, { withFileTypes: true });
        for (const entry of entries) if (entry.isDirectory()) await addScope(join(store, entry.name, "node_modules", "@deepseek-ai"));
        break;
      } catch {}
      const parent = resolve(cursor, ".."); if (parent === cursor) break; cursor = parent;
    }
  }
  return [...scopes];
}
async function safeRealpath(value: string): Promise<string> { try { return await realpath(value); } catch { return value; } }
async function collectRc6FamilyPackages(scopes: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const scope of scopes) {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(scope, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if ((name !== "dsh" && !name.startsWith("dsh-")) || found.has(name)) continue;
      const candidate = join(scope, name);
      if (await validRc6Package(candidate, name)) found.set(name, candidate);
    }
  }
  return found;
}
async function validRc6Package(directory: string, name: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string };
    return manifest.name === `@deepseek-ai/${name}` && manifest.version === SUPPORTED_DSH_VERSION;
  } catch { return false; }
}
