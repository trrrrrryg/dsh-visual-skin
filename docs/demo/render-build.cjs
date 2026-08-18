// Render build-b.html -> MP4 + GIF (12fps GIF, 30fps MP4)
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
(async () => {
  const FPS = 30, DURATION = 7, W = 1920, H = 1080;
  const HTML = "file:///D:/ruanjianproject/dsh%E8%83%8C%E6%99%AF%E6%9B%B4%E6%8D%A2/docs/demo/build-b.html";
  const OUT = "D:\\ruanjianproject\\dsh背景更换\\docs\\demo\\out";
  const TMP = path.join(OUT, ".b-frames-" + Date.now() + "-" + process.pid);
  fs.mkdirSync(TMP, { recursive: true });
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--disable-gpu", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(HTML, { waitUntil: "load" });
  await page.waitForTimeout(600);
  const TOTAL = Math.round(DURATION * FPS);
  for (let i = 0; i < TOTAL; i++) {
    await page.evaluate((tt) => window.__seek(tt), i / FPS);
    await page.screenshot({ path: path.join(TMP, `f${String(i).padStart(4, "0")}.png`) });
  }
  await browser.close();
  execSync(`ffmpeg -y -framerate ${FPS} -i "${TMP}\\f%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "${OUT}\\build-b-30fps.mp4"`, { stdio: "inherit" });
  execSync(`ffmpeg -y -framerate 12 -i "${TMP}\\f%04d.png" -vf "scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 -gifflags +transdiff "${OUT}\\build-b-960.gif"`, { stdio: "inherit" });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
