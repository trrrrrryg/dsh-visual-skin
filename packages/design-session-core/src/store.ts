import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export class AtomicJsonStore {
  constructor(readonly root: string) {}

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  async read<T>(relative: string): Promise<T | null> {
    try {
      // Older Windows PowerShell installers may have written UTF-8 JSON with
      // a BOM. Node's JSON.parse does not accept that leading U+FEFF, which
      // previously made unrelated reads (such as an apply-plan lookup) fail
      // with a 500 even though the record itself was otherwise valid.
      const text = await readFile(this.path(relative), "utf8");
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write<T>(relative: string, value: T): Promise<void> {
    const target = this.path(relative);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temp, target);
  }

  async append(relative: string, value: unknown): Promise<void> {
    const target = this.path(relative);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
  }

  async list(relative: string, suffix = ""): Promise<string[]> {
    try {
      return (await readdir(this.path(relative))).filter((name) => name.endsWith(suffix)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async remove(relative: string): Promise<void> {
    try { await unlink(this.path(relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async withLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const lock = this.path("locks", `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
    await mkdir(dirname(lock), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const handle = await open(lock, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
          return await callback();
        } finally {
          await handle.close();
          try { await unlink(lock); } catch {}
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) { await unlink(lock); continue; } } catch {}
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock ${name}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 40 + Math.floor(Math.random() * 40)));
      }
    }
  }
}
