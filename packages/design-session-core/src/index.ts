import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DesignSession, OperationKind, OperationRecord } from "@dsh-skin/shared";
import { ERROR_CODES } from "@dsh-skin/shared";
import { DEFAULT_THEME, mergeThemeSpec, parseThemeSpec, type ThemeSpec } from "@dsh-skin/theme-schema";
import { AppError } from "./errors.js";
import { AtomicJsonStore } from "./store.js";

export { AppError, AtomicJsonStore };

export interface ConfirmationBinding {
  action: "apply" | "restore";
  designId: string;
  revision: number;
  targetKey: string;
  profile: string;
  installPlugin: boolean;
  planHash: string;
  /** An apply is only meaningful after this exact isolated draft was rendered. */
  previewSessionId?: string;
  previewGeneration?: number;
  renderReceiptHash?: string;
}

interface ConfirmationRecord extends ConfirmationBinding {
  sessionHash: string;
  expiresAt: string;
  usedAt?: string;
}

export interface PreviewSessionRecord {
  profile: string;
  designId: string;
  revision: number;
  hash: string;
  theme: ThemeSpec;
  state: "pending" | "live" | "stopped" | "expired";
  createdAt: string;
  expiresAt: string;
  ack?: { revision: number; hash: string; pluginInstanceId: string; clientInstanceId: string; at: string };
}

export class DesignSessionCore {
  readonly store: AtomicJsonStore;
  private readonly mutexes = new Map<string, Promise<void>>();
  constructor(readonly dataDir: string) {
    this.store = new AtomicJsonStore(dataDir);
  }

  async createDesign(input?: { name?: string; theme?: unknown }): Promise<DesignSession<ThemeSpec>> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const theme = parseThemeSpec(input?.theme ?? DEFAULT_THEME);
    const session: DesignSession<ThemeSpec> = {
      id,
      name: input?.name?.trim() || theme.name,
      revision: 1,
      theme,
      createdAt: now,
      updatedAt: now
    };
    await this.store.write(`designs/${id}.json`, session);
    return session;
  }

  async getDesign(id: string): Promise<DesignSession<ThemeSpec>> {
    const found = await this.store.read<DesignSession<ThemeSpec>>(`designs/${id}.json`);
    if (found === null) throw new AppError(ERROR_CODES.notFound, `Design ${id} was not found`, 404);
    return { ...found, theme: parseThemeSpec(found.theme) };
  }

  async listDesigns(): Promise<DesignSession<ThemeSpec>[]> {
    const names = await this.store.list("designs", ".json");
    const designs = await Promise.all(names.map((name) => this.store.read<DesignSession<ThemeSpec>>(`designs/${name}`)));
    return designs.filter((item): item is DesignSession<ThemeSpec> => item !== null)
      .map((item) => ({ ...item, theme: parseThemeSpec(item.theme) }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async duplicateDesign(id: string, name?: string, patchId?: string): Promise<DesignSession<ThemeSpec>> {
    return this.withDesignLock(id, async () => {
      const requestHash = canonicalHash({ kind: "duplicate", id, name: name?.trim() || null });
      const prior = patchId ? await this.idempotentResult(id, patchId, requestHash) : null;
      if (prior) return prior;
      const source = await this.getDesign(id);
      const suffix = randomUUID().slice(0, 8);
      const created = await this.createDesign({ name: name?.trim() || `${source.name} Copy`, theme: { ...source.theme, id: `${source.theme.id.slice(0, 35)}-${suffix}` } });
      if (patchId) await this.saveIdempotentResult(id, patchId, requestHash, created);
      return created;
    });
  }

  async renameDesign(id: string, baseRevision: number, name: string, patchId?: string): Promise<DesignSession<ThemeSpec>> {
    return this.withDesignLock(id, async () => {
      const requestHash = canonicalHash({ kind: "rename", id, baseRevision, name: name.trim() });
      const prior = patchId ? await this.idempotentResult(id, patchId, requestHash) : null;
      if (prior) return prior;
      const current = await this.getDesign(id);
      if (current.revision !== baseRevision) throw new AppError(ERROR_CODES.conflict, "The design changed since it was loaded", 409, { expectedRevision: current.revision, receivedRevision: baseRevision });
      const updated: DesignSession<ThemeSpec> = { ...current, name: name.trim(), revision: current.revision + 1, updatedAt: new Date().toISOString() };
      await this.store.write(`designs/${id}.json`, updated);
      if (patchId) await this.saveIdempotentResult(id, patchId, requestHash, updated);
      return updated;
    });
  }

  async deleteDesign(id: string, protectedIds: ReadonlySet<string>): Promise<void> {
    await this.withDesignLock(id, async () => {
      const designs = await this.listDesigns();
      if (designs.length <= 1) throw new AppError(ERROR_CODES.conflict, "The only design cannot be deleted", 409);
      if (protectedIds.has(id)) throw new AppError(ERROR_CODES.conflict, "An active, applied, restorable, or previewed design cannot be deleted", 409);
      await this.getDesign(id);
      await this.store.remove(`designs/${id}.json`);
    });
  }

  async patchDesign(id: string, baseRevision: number, patch: Partial<ThemeSpec>, patchId?: string): Promise<DesignSession<ThemeSpec>> {
    return this.withDesignLock(id, async () => {
      const requestHash = canonicalHash({ kind: "patch", id, baseRevision, patch });
      const prior = patchId ? await this.idempotentResult(id, patchId, requestHash) : null;
      if (prior) return prior;
      const current = await this.getDesign(id);
      if (!Number.isInteger(baseRevision) || baseRevision !== current.revision) {
        throw new AppError(ERROR_CODES.conflict, "The design changed since it was loaded", 409, {
          expectedRevision: current.revision,
          receivedRevision: baseRevision
        });
      }
      const updated: DesignSession<ThemeSpec> = {
        ...current,
        revision: current.revision + 1,
        theme: mergeThemeSpec(current.theme, patch),
        updatedAt: new Date().toISOString()
      };
      await this.store.write(`designs/${id}.json`, updated);
      if (patchId) await this.saveIdempotentResult(id, patchId, requestHash, updated);
      return updated;
    });
  }

  validateTheme(input: unknown): { valid: true; theme: ThemeSpec } {
    return { valid: true, theme: parseThemeSpec(input) };
  }

  async createBrowserSession(): Promise<string> {
    const sessionId = randomBytes(32).toString("base64url");
    const sessionHash = hashText(sessionId);
    const now = new Date();
    await this.store.write(`browser-sessions/${sessionHash}.json`, { createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString() });
    return sessionId;
  }

  async validateBrowserSession(sessionId: string | undefined): Promise<string> {
    if (!sessionId) throw new AppError(ERROR_CODES.confirmation, "A visible Studio browser session is required", 403);
    const sessionHash = hashText(sessionId);
    const session = await this.store.read<{ createdAt: string; expiresAt?: string }>(`browser-sessions/${sessionHash}.json`);
    if (!session?.expiresAt || Date.parse(session.expiresAt) <= Date.now()) throw new AppError(ERROR_CODES.confirmation, "The Studio browser session is invalid or expired", 403);
    return sessionHash;
  }

  async createConfirmation(sessionId: string | undefined, binding: ConfirmationBinding): Promise<{ confirmed: true; expiresAt: string; planHash: string }> {
    const sessionHash = await this.validateBrowserSession(sessionId);
    const design = await this.getDesign(binding.designId);
    if (design.revision !== binding.revision) throw new AppError(ERROR_CODES.conflict, "Confirmation revision is stale", 409);
    const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
    const record: ConfirmationRecord = { ...binding, sessionHash, expiresAt };
    await this.store.write(`confirmations/${sessionHash}-${binding.action}.json`, record);
    return { confirmed: true, expiresAt, planHash: binding.planHash };
  }

  async consumeConfirmation(sessionId: string | undefined, binding: ConfirmationBinding): Promise<void> {
    const sessionHash = await this.validateBrowserSession(sessionId);
    await this.store.withLock(`confirmation-${sessionHash}-${binding.action}`, async () => {
      const relative = `confirmations/${sessionHash}-${binding.action}.json`;
      const record = await this.store.read<ConfirmationRecord>(relative);
      if (!record || record.usedAt || Date.parse(record.expiresAt) <= Date.now() || canonicalHash(record) !== canonicalHash({ ...binding, sessionHash, expiresAt: record?.expiresAt })) {
        throw new AppError(ERROR_CODES.confirmation, "Confirmation is missing, expired, used, or the immutable apply plan changed", 403);
      }
      await this.store.write(relative, { ...record, usedAt: new Date().toISOString() });
    });
  }

  async startPreview(profile: string, designId: string, revision: number, ttlMs = 2 * 60_000): Promise<PreviewSessionRecord> {
    const design = await this.getDesign(designId);
    if (design.revision !== revision) throw new AppError(ERROR_CODES.conflict, "Preview revision is stale", 409, { expectedRevision: design.revision });
    const now = new Date();
    const preview: PreviewSessionRecord = {
      profile, designId, revision, hash: canonicalHash(design.theme), theme: design.theme,
      state: "pending", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    await this.store.write(`previews/${profile}.json`, preview);
    return preview;
  }

  async stopPreview(profile: string): Promise<PreviewSessionRecord | null> {
    const current = await this.getPreview(profile);
    if (!current) return null;
    const stopped: PreviewSessionRecord = { ...current, state: "stopped" };
    await this.store.write(`previews/${profile}.json`, stopped);
    return stopped;
  }

  async getPreview(profile: string): Promise<PreviewSessionRecord | null> {
    const current = await this.store.read<PreviewSessionRecord>(`previews/${profile}.json`);
    if (!current) return null;
    if (["pending", "live"].includes(current.state) && Date.parse(current.expiresAt) <= Date.now()) {
      const expired: PreviewSessionRecord = { ...current, state: "expired" };
      await this.store.write(`previews/${profile}.json`, expired);
      return expired;
    }
    return { ...current, theme: parseThemeSpec(current.theme) };
  }

  async ackPreview(profile: string, designId: string, revision: number, hash: string, pluginInstanceId: string, clientInstanceId: string): Promise<PreviewSessionRecord> {
    return this.store.withLock(`preview-${profile}`, async () => {
      const current = await this.getPreview(profile);
      if (!current || current.state === "stopped" || current.state === "expired" || current.designId !== designId || current.revision !== revision || current.hash !== hash) {
        throw new AppError(ERROR_CODES.conflict, "Preview acknowledgement does not match the active draft", 409);
      }
      const live: PreviewSessionRecord = { ...current, state: "live", ack: { revision, hash, pluginInstanceId, clientInstanceId, at: new Date().toISOString() } };
      await this.store.write(`previews/${profile}.json`, live);
      return live;
    });
  }

  async startOperation(kind: OperationKind, detail?: string): Promise<OperationRecord> {
    const now = new Date().toISOString();
    const operation: OperationRecord = {
      id: randomUUID(), kind, state: "running", createdAt: now, updatedAt: now,
      ...(detail ? { detail } : {})
    };
    await this.saveOperation(operation);
    return operation;
  }

  async finishOperation(id: string, error?: { code: string; message: string }): Promise<OperationRecord> {
    const current = await this.getOperation(id);
    const operation: OperationRecord = {
      ...current,
      state: error ? "failed" : "succeeded",
      updatedAt: new Date().toISOString(),
      ...(error ? { error } : {})
    };
    await this.saveOperation(operation);
    return operation;
  }

  async transitionOperation(id: string, state: OperationRecord["state"], options?: { error?: { code: string; message: string }; expected?: OperationRecord["expected"] }): Promise<OperationRecord> {
    const current = await this.getOperation(id);
    const operation: OperationRecord = {
      ...current, state, updatedAt: new Date().toISOString(),
      ...(options?.error ? { error: options.error } : {}),
      ...(options?.expected ? { expected: options.expected } : {})
    };
    await this.saveOperation(operation);
    return operation;
  }

  async getOperation(id: string): Promise<OperationRecord> {
    const found = await this.store.read<OperationRecord>(`operations/${id}.json`);
    if (found === null) throw new AppError(ERROR_CODES.notFound, `Operation ${id} was not found`, 404);
    return found;
  }

  private async saveOperation(operation: OperationRecord): Promise<void> {
    await this.store.write(`operations/${operation.id}.json`, operation);
    await this.store.append("operations/journal.jsonl", operation);
  }

  async withResourceLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return this.withProcessLock(name, () => this.store.withLock(name, callback));
  }

  private withDesignLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    return this.withProcessLock(`design-${id}`, () => this.store.withLock(`design-${id}`, callback));
  }

  private async idempotentResult(id: string, patchId: string, requestHash: string): Promise<DesignSession<ThemeSpec> | null> {
    const prior = await this.store.read<{ requestHash?: string; session: DesignSession<ThemeSpec> }>(`patches/${id}/${patchId}.json`);
    if (!prior) return null;
    if (prior.requestHash !== requestHash) throw new AppError(ERROR_CODES.conflict, "patchId was already used for a different mutation payload", 409);
    return { ...prior.session, theme: parseThemeSpec(prior.session.theme) };
  }

  private saveIdempotentResult(id: string, patchId: string, requestHash: string, session: DesignSession<ThemeSpec>): Promise<void> {
    return this.store.write(`patches/${id}/${patchId}.json`, { requestHash, session, appliedAt: session.updatedAt });
  }

  private async withProcessLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const prior = this.mutexes.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const chained = prior.then(() => current);
    this.mutexes.set(name, chained);
    await prior;
    try { return await callback(); }
    finally { release(); if (this.mutexes.get(name) === chained) this.mutexes.delete(name); }
  }
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
