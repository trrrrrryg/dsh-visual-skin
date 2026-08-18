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
    return { opened: true, url };
  } catch (error) {
    return { opened: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) { try { await access(path); return path; } catch {} }
  return null;
}
