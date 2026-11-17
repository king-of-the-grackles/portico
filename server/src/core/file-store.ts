import { mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BucketConfig } from "./types";

/**
 * Where files' bytes live. A bucket hands out addresses that go straight to storage, so large files never pass through
 * Portico. The data folder has no addresses of its own: Portico's signed /files routes carry the bytes instead.
 */
export interface FileStore {
  /** An address the bytes can be PUT to for `seconds`, or null when Portico's own route takes them. */
  uploadUrl(key: string, seconds: number): string | null;
  /** An address the file downloads from for `seconds`, always as a download named `name`, or null likewise. */
  downloadUrl(key: string, name: string, seconds: number): string | null;
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** The stored size, and a mark that changes when the bytes do; null when nothing is stored. */
  stat(key: string): Promise<{ size: number; etag: string } | null>;
  remove(key: string): Promise<void>;
  /** The data folder only: whether the disk can take `bytes` more and still leave room for the database. */
  hasRoom?(bytes: number): boolean;
}

/** What the data folder's disk keeps free for the database, its backups and the log. */
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

/** `attachment`, with the name in both the plain and the UTF-8 form, so a file never opens as a page. */
export function downloadDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Any S3-compatible bucket, through Bun's own client. */
export class BucketStore implements FileStore {
  private readonly s3: Bun.S3Client;

  constructor(
    config: BucketConfig,
    /** Put before every key: hosted Portico keeps each workspace's files under its own prefix. */
    private readonly prefix = "files/",
  ) {
    this.s3 = new Bun.S3Client({
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.region ? { region: config.region } : {}),
    });
  }

  uploadUrl(key: string, seconds: number): string {
    return this.s3.presign(this.prefix + key, { method: "PUT", expiresIn: seconds });
  }

  downloadUrl(key: string, name: string, seconds: number): string {
    return this.s3.presign(this.prefix + key, {
      method: "GET",
      expiresIn: seconds,
      contentDisposition: downloadDisposition(name),
      type: "application/octet-stream",
    });
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    await this.s3.write(this.prefix + key, bytes, { type: "application/octet-stream" });
  }

  async stat(key: string): Promise<{ size: number; etag: string } | null> {
    try {
      const stat = await this.s3.stat(this.prefix + key);
      return { size: stat.size, etag: stat.etag };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "NoSuchKey" || code === "NotFound") return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    await this.s3.delete(this.prefix + key);
  }
}

/** `files` in the data folder, for a Portico with no bucket. The folder is made on the first write. */
export class FolderStore implements FileStore {
  constructor(private readonly dir: string) {}

  uploadUrl(): null {
    return null;
  }

  downloadUrl(): null {
    return null;
  }

  path(key: string): string {
    return join(this.dir, key);
  }

  /** The database shares this disk, and a full disk stops Portico, so files never take the last of it. */
  hasRoom(bytes: number): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      const disk = statfsSync(this.dir);
      return disk.bavail * disk.bsize - bytes >= DISK_RESERVE_BYTES;
    } catch {
      return true;
    }
  }

  /** Where an upload is written until every byte has arrived. */
  partPath(key: string): string {
    mkdirSync(this.dir, { recursive: true });
    return join(this.dir, `${key}.part`);
  }

  /** The finished upload takes the file's place in one step. */
  keep(key: string): void {
    renameSync(this.partPath(key), this.path(key));
  }

  discardPart(key: string): void {
    rmSync(join(this.dir, `${key}.part`), { force: true });
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    await Bun.write(this.path(key), bytes);
  }

  async stat(key: string): Promise<{ size: number; etag: string } | null> {
    try {
      return { size: statSync(this.path(key)).size, etag: "" };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
    this.discardPart(key);
  }
}

export function fileStoreFor(config: { dataDir: string; files: BucketConfig | null }): FileStore {
  return config.files ? new BucketStore(config.files) : new FolderStore(join(config.dataDir, "files"));
}
