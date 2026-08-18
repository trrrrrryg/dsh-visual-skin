import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { AssetRecord } from "@dsh-skin/shared";
import { ERROR_CODES } from "@dsh-skin/shared";
import { AtomicJsonStore, AppError } from "@dsh-skin/design-session-core";
import sharp from "sharp";

/**
 * Allows ordinary desktop background images while keeping decoding bounded.
 * The request ceiling includes base64/JSON overhead and is applied only to
 * the asset route; every other Controller mutation stays at 1 MiB.
 */
export const MAX_BACKGROUND_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_BACKGROUND_ASSET_BASE64_CHARS = Math.ceil(MAX_BACKGROUND_ASSET_BYTES / 3) * 4;
export const MAX_BACKGROUND_ASSET_REQUEST_BYTES = 6 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 25_000_000;
const EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" } as const;
type AllowedMime = keyof typeof EXTENSIONS;

export class AssetService {
  private readonly store: AtomicJsonStore;
  private readonly assetDir: string;
  constructor(private readonly dataDir: string) {
    this.store = new AtomicJsonStore(dataDir);
    this.assetDir = resolve(dataDir, "assets", "content");
  }

  async upload(input: { mimeType: string; dataBase64: string }): Promise<AssetRecord> {
    if (!(input.mimeType in EXTENSIONS)) throw new AppError(ERROR_CODES.validation, "Only PNG, JPEG, and WebP assets are accepted", 422);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64) || input.dataBase64.length % 4 !== 0) {
      throw new AppError(ERROR_CODES.validation, "Asset data must be canonical base64", 422);
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_BACKGROUND_ASSET_BYTES) throw new AppError(ERROR_CODES.validation, `Asset must be 1-${MAX_BACKGROUND_ASSET_BYTES} bytes`, 422);
    const detectedMime = detectMimeByMagic(bytes);
    if (detectedMime !== input.mimeType) throw new AppError(ERROR_CODES.validation, "Declared MIME does not match the image magic bytes", 422);
    const decoded = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).timeout({ seconds: 3 }).rotate();
    let metadata;
    try { metadata = await decoded.metadata(); }
    catch { throw new AppError(ERROR_CODES.validation, "Image decoding failed", 422); }
    const width = metadata.width ?? 0, height = metadata.height ?? 0;
    if (metadata.pages && metadata.pages > 1) throw new AppError(ERROR_CODES.validation, "Animated or multi-page images are not accepted", 422);
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      throw new AppError(ERROR_CODES.validation, "Image dimensions exceed the safe decoding limit", 422);
    }
    let canonical: Buffer;
    let canonicalWidth = width;
    let canonicalHeight = height;
    try {
      const pipeline = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).timeout({ seconds: 3 }).rotate();
      const encoded = input.mimeType === "image/png" ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
        : input.mimeType === "image/jpeg" ? await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer({ resolveWithObject: true })
        : await pipeline.webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
      canonical = encoded.data;
      canonicalWidth = encoded.info.width;
      canonicalHeight = encoded.info.height;
    } catch { throw new AppError(ERROR_CODES.validation, "Image canonical re-encoding failed", 422); }
    if (canonical.length <= 0 || canonical.length > MAX_BACKGROUND_ASSET_BYTES) throw new AppError(ERROR_CODES.validation, "Canonical image exceeds the storage limit", 422);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const id = `sha256-${hash}`;
    const mimeType = detectedMime;
    const target = this.contentPath(id, EXTENSIONS[mimeType]);
    await mkdir(dirname(target), { recursive: true });
    try { await stat(target); } catch {
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, canonical, { flag: "wx" });
      await rename(temp, target);
    }
    const record: AssetRecord = { id, mimeType, bytes: canonical.length, width: canonicalWidth, height: canonicalHeight, createdAt: new Date().toISOString() };
    await this.store.write(`assets/meta/${id}.json`, record);
    return record;
  }

  async get(id: string): Promise<{ record: AssetRecord; bytes: Buffer }> {
    assertAssetId(id);
    const record = await this.store.read<AssetRecord>(`assets/meta/${id}.json`);
    if (!record) throw new AppError(ERROR_CODES.notFound, "Asset was not found", 404);
    const path = this.contentPath(id, EXTENSIONS[record.mimeType]);
    const info = await stat(path);
    if (!info.isFile() || info.size !== record.bytes || info.size > MAX_BACKGROUND_ASSET_BYTES) throw new AppError(ERROR_CODES.unavailable, "Asset storage integrity check failed", 409);
    return { record, bytes: await readFile(path) };
  }

  private contentPath(id: string, extension: string): string {
    assertAssetId(id);
    const path = resolve(this.assetDir, `${id}${extension}`);
    if (!path.startsWith(`${this.assetDir}\\`) && dirname(path) !== this.assetDir) throw new AppError(ERROR_CODES.badRequest, "Invalid asset path", 400);
    return path;
  }
}

function assertAssetId(id: string): void {
  if (!/^sha256-[0-9a-f]{64}$/.test(id) || extname(id) !== "") throw new AppError(ERROR_CODES.badRequest, "Invalid asset id", 400);
}

function detectMimeByMagic(buffer: Buffer): AllowedMime {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new AppError(ERROR_CODES.validation, "Unsupported image magic bytes", 422);
}
