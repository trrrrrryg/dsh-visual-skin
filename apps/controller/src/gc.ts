import { rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { DesignSessionCore } from "@dsh-skin/design-session-core";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const JOURNAL_ROTATE_BYTES = 1_048_576;
const JOURNAL_ARCHIVES_KEPT = 3;
const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "failed-safe"]);
const TERMINAL_PREVIEW_STATES = new Set(["stopped", "expired", "failed-safe"]);
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GcSummary {
  browserSessions: number;
  confirmations: number;
  operations: number;
  patches: number;
  transactions: number;
  previewSessions: number;
  previewRuntimeDirs: number;
  cleanupRecords: number;
  journalRotated: boolean;
  errors: number;
}

/**
 * Bounded best-effort garbage collection over the Controller data directory.
 * Only records that are provably dead are removed: expired browser sessions
 * and confirmations, terminal operations/transactions/patches older than one
 * day, and terminal isolated-preview records (plus their runtime dirs and
 * cleanup records). Never touches durable state: `active/`, `applied-designs/`,
 * `restore-state/`, `installations/`, `plugin-secrets/`, `designs/`, `assets/`.
 * The operations journal is append-only by design; it is rotated (not pruned)
 * only during the startup pass, where no concurrent append can race it.
 */
export function startGarbageCollector(core: DesignSessionCore, options: { intervalMs?: number } = {}): () => void {
  const run = (label: string, rotateJournal: boolean) => {
    void runGarbageCollection(core, { rotateJournal })
      .then((summary) => logSummary(label, summary))
      .catch((error) => {
        process.stderr.write(`[dsh-skin] garbage collection (${label}) failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  };
  run("startup", true);
  const timer = setInterval(() => run("interval", false), options.intervalMs ?? HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function runGarbageCollection(core: DesignSessionCore, options: { rotateJournal?: boolean } = {}): Promise<GcSummary> {
  const summary: GcSummary = {
    browserSessions: 0, confirmations: 0, operations: 0, patches: 0, transactions: 0,
    previewSessions: 0, previewRuntimeDirs: 0, cleanupRecords: 0, journalRotated: false, errors: 0
  };
  const now = Date.now();
  const removedPreviewIds: string[] = [];
  try {
    for (const name of await core.store.list("browser-sessions", ".json")) {
      const record = await core.store.read<{ expiresAt?: string }>(`browser-sessions/${name}`);
      if (record === null || !record.expiresAt || Date.parse(record.expiresAt) <= now) {
        await core.store.remove(`browser-sessions/${name}`);
        summary.browserSessions += 1;
      }
    }
    for (const name of await core.store.list("confirmations", ".json")) {
      const record = await core.store.read<{ usedAt?: string; expiresAt?: string }>(`confirmations/${name}`);
      if (record === null || record.usedAt !== undefined || (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now)) {
        await core.store.remove(`confirmations/${name}`);
        summary.confirmations += 1;
      }
    }
    for (const name of await core.store.list("operations", ".json")) {
      if (name === "journal.jsonl") continue;
      const record = await core.store.read<{ state?: string; updatedAt?: string }>(`operations/${name}`);
      if (record !== null && record.updatedAt !== undefined && TERMINAL_OPERATION_STATES.has(record.state ?? "")
        && now - Date.parse(record.updatedAt) > DAY_MS) {
        await core.store.remove(`operations/${name}`);
        summary.operations += 1;
      }
    }
    for (const designDir of await core.store.list("patches")) {
      if (!UUID_DIR.test(designDir)) continue;
      for (const name of await core.store.list(`patches/${designDir}`, ".json")) {
        const record = await core.store.read<{ appliedAt?: string }>(`patches/${designDir}/${name}`);
        if (record !== null && record.appliedAt !== undefined && now - Date.parse(record.appliedAt) > DAY_MS) {
          await core.store.remove(`patches/${designDir}/${name}`);
          summary.patches += 1;
        }
      }
    }
    for (const name of await core.store.list("transactions", ".json")) {
      // Every terminal state is reclaimed: committed (successful apply/restore/
      // install/uninstall), failed-safe/rollback-incomplete (rolled back), and
      // prepared (crash residue — nothing reads prepared transactions after a
      // Controller restart, so an old one is provably dead).
      const record = await core.store.read<{ state?: string; committedAt?: string; failedAt?: string; createdAt?: string }>(`transactions/${name}`);
      if (record === null) { await core.store.remove(`transactions/${name}`); summary.transactions += 1; continue; }
      const state = record.state ?? "";
      const stamp = record.committedAt ?? record.failedAt ?? (state === "prepared" ? record.createdAt : undefined);
      if (stamp !== undefined && now - Date.parse(stamp) > DAY_MS) {
        await core.store.remove(`transactions/${name}`);
        summary.transactions += 1;
      }
    }
    for (const name of await core.store.list("isolated-preview-sessions", ".json")) {
      const record = await core.store.read<{ state?: string; createdAt?: string }>(`isolated-preview-sessions/${name}`);
      if (record !== null && record.createdAt !== undefined && TERMINAL_PREVIEW_STATES.has(record.state ?? "")
        && now - Date.parse(record.createdAt) > DAY_MS) {
        await core.store.remove(`isolated-preview-sessions/${name}`);
        summary.previewSessions += 1;
        const id = name.replace(/\.json$/i, "");
        if (UUID_DIR.test(id)) removedPreviewIds.push(id);
      }
    }
    for (const id of removedPreviewIds) {
      try {
        await rm(core.store.path("isolated-preview-runtime", id), { recursive: true, force: true });
        summary.previewRuntimeDirs += 1;
      } catch { /* the dir may already be gone */ }
      try {
        // Orphaned disposable homes (%TEMP%\dsh-skin-isolated-<uuid>.dsh) are
        // reaped here too. reconcile() deliberately keeps them when process
        // ownership cannot be proven (PID-reuse safety), so this is the only
        // bounded retry path for that residue once the session record itself
        // is terminal and older than one day.
        const home = join(tmpdir(), `dsh-skin-isolated-${id}.dsh`);
        const expected = resolve(tmpdir()).toLowerCase();
        if (resolve(home).toLowerCase().startsWith(`${expected}${process.platform === "win32" ? "\\" : "/"}dsh-skin-isolated-`) && (await stat(home).catch(() => null)) !== null) {
          await rm(home, { recursive: true, force: true });
          summary.previewRuntimeDirs += 1;
        }
      } catch { /* the dir may already be gone */ }
    }
    if (removedPreviewIds.length > 0) {
      for (const name of await core.store.list("isolated-preview-cleanup", ".json")) {
        const record = await core.store.read<{ id?: string }>(`isolated-preview-cleanup/${name}`);
        if (record !== null && record.id !== undefined && removedPreviewIds.includes(record.id)) {
          await core.store.remove(`isolated-preview-cleanup/${name}`);
          summary.cleanupRecords += 1;
        }
      }
    }
    if (options.rotateJournal) await rotateJournal(core, summary);
  } catch (error) {
    summary.errors += 1;
    process.stderr.write(`[dsh-skin] garbage collection failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return summary;
}

async function rotateJournal(core: DesignSessionCore, summary: GcSummary): Promise<void> {
  const journal = core.store.path("operations", "journal.jsonl");
  let size = 0;
  try { size = (await stat(journal)).size; } catch { return; }
  if (size <= JOURNAL_ROTATE_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(journal, `${dirname(journal)}${process.platform === "win32" ? "\\" : "/"}journal-${stamp}.jsonl`);
  summary.journalRotated = true;
  const archives = (await core.store.list("operations", ".jsonl")).filter((name) => name.startsWith("journal-")).sort();
  const stale = archives.slice(0, Math.max(0, archives.length - JOURNAL_ARCHIVES_KEPT));
  for (const name of stale) await core.store.remove(`operations/${name}`);
}

function logSummary(label: string, summary: GcSummary): void {
  if (label !== "startup" && summary.browserSessions === 0 && summary.confirmations === 0 && summary.operations === 0
    && summary.patches === 0 && summary.transactions === 0 && summary.previewSessions === 0 && !summary.journalRotated) return;
  process.stderr.write(`[dsh-skin] gc (${label}): browser=${summary.browserSessions} confirmations=${summary.confirmations} operations=${summary.operations} patches=${summary.patches} transactions=${summary.transactions} previews=${summary.previewSessions} runtimeDirs=${summary.previewRuntimeDirs} cleanupRecords=${summary.cleanupRecords} journal=${summary.journalRotated ? "rotated" : "kept"} errors=${summary.errors}\n`);
}
