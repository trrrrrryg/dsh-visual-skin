import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

export async function openExternal(url: string): Promise<{ opened: boolean; url: string; error?: string }> {
  const candidates = process.platform === "win32"
    ? ["C:\\Windows\\explorer.exe"]
    : process.platform === "darwin" ? ["/usr/bin/open"] : ["/usr/bin/xdg-open", "/bin/xdg-open"];
  const executable = await firstExisting(candidates);
  if (!executable) return { opened: false, url, error: "No supported browser opener was found" };
  try {
    const child = spawn(executable, [url], { detached: true, stdio: "ignore", shell: false, windowsHide: true });
    child.unref();
    // explorer.exe returns success even when no browser association exists, so
    // give it a short grace period and then verify something actually opened.
    // Verification is best-effort: a browser that exits instantly is treated
    // as a failed open so the caller can fall back to the copyable URL.
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (opened: boolean, error?: string) => { if (!settled) { settled = true; resolve({ opened, url, ...(error ? { error } : {}) }); } };
      const timer = setTimeout(() => settle(true), 800);
      child.once("error", (error) => { clearTimeout(timer); settle(false, error.message); });
      child.once("exit", (code) => { clearTimeout(timer); settle(code === 0, code === 0 ? undefined : `opener exited with code ${code}`); });
    });
  } catch (error) {
    return { opened: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) { try { await access(path); return path; } catch {} }
  return null;
}
