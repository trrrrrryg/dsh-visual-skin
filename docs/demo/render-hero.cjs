// Render hero-a.html to frames -> MP4 + GIF using __seek (deterministic).
// Usage: node render-hero.mjs <fps> <out-dir>
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const FPS = Number(process.argv[2] || 30);
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(ROOT, process.argv[3] || "docs/demo/out");
const DURATION = 10;
const W = 1920, H = 1080;
const HTML = `file://${path.join(__dirname, "hero-a.html").replace(/\\/g, "/")}`;
const TMP = path.join(OUT, ".frames-" + Date.now() + "-" + process.pid);
fs.mkdirSync(TMP, { recursive: true });
const TOTAL = Math.round(DURATION * FPS);

(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--disable-gpu", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(HTML, { waitUntil: "load" });
  await page.waitForTimeout(600);
  for (let i = 0; i < TOTAL; i++) {
    const t = i / FPS;
    await page.evaluate((tt) => window.__seek(tt), t);
    await page.screenshot({ path: path.join(TMP, `f${String(i).padStart(4, "0")}.png`) });
    if (i % 90 === 0) console.log(`frame ${i}/${TOTAL}`);
  }
  await browser.close();

  // MP4 (H.264 CRF 18)
  execSync(`ffmpeg -y -framerate ${FPS} -i "${TMP}\\f%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "${path.join(OUT, `hero-a-${FPS}fps.mp4`)}"`, { stdio: "inherit" });
  // GIF (960 wide, palette optimized)
  execSync(`ffmpeg -y -framerate ${Math.min(15, FPS)} -i "${TMP}\\f%04d.png" -vf "scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 -gifflags +transdiff "${path.join(OUT, "hero-a-960.gif")}"`, { stdio: "inherit" });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
