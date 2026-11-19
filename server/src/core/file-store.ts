import { copyFileSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BucketConfig } from "./types";

/**
 * Where files' bytes live. A bucket hands out addresses that go straight to storage, so large files never pass through
 * Portico. The data folder has no addresses of its own: Portico's signed /files routes carry the bytes instead.
 *
 * A key is the whole place of a file, the same in a bucket and in the data folder: `uploads/<file ID>` for a file no
 * message carries yet, and `porticos/<workspace ID>/files/<file ID>` for a workspace's own copy (core/files.ts makes
 * both). Nothing is put in front of a key.
 */
export interface FileStore {
  /** An address the bytes can be PUT to for `seconds`, or null when Portico's own route takes them. */
  uploadUrl(key: string, seconds: number): string | null;
  /** An address the file downloads from for `seconds`, always as a download named `name`, or null likewise. */
  downloadUrl(key: string, name: string, seconds: number): string | null;
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** Copies the bytes at one key to another: a file attached in a workspace becomes that workspace's own copy. */
  copy(fromKey: string, toKey: string): Promise<void>;
  /** The stored size, and a mark that changes when the bytes do; null when nothing is stored. */
  stat(key: string): Promise<{ size: number; etag: string } | null>;
  remove(key: string): Promise<void>;
  /** The data folder only: whether the disk can take `bytes` more and still leave room for the databases. */
  hasRoom?(bytes: number): boolean;
}

/** The key of a file no message carries yet. */
export function uploadKey(fileId: string): string {
  return `uploads/${fileId}`;
}

/** The key of a workspace's own copy of a file. In the data folder, that is inside the workspace's own folder. */
export function workspaceFileKey(workspaceId: string, fileId: string): string {
  return `porticos/${workspaceId}/files/${fileId}`;
}

/** What the data folder's disk keeps free for the databases, their backups and the log. */
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

/** `attachment`, with the name in both the plain and the UTF-8 form, so a file never opens as a page. */
export function downloadDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Any S3-compatible bucket, through Bun's own client. */
export class BucketStore implements FileStore {
  private readonly s3: Bun.S3Client;

  constructor(config: BucketConfig) {
    this.s3 = new Bun.S3Client({
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.region ? { region: config.region } : {}),
    });
  }

  uploadUrl(key: string, seconds: number): string {
    return this.s3.presign(key, { method: "PUT", expiresIn: seconds });
  }

  downloadUrl(key: string, name: string, seconds: number): string {
    return this.s3.presign(key, {
      method: "GET",
      expiresIn: seconds,
      contentDisposition: downloadDisposition(name),
      type: "application/octet-stream",
    });
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    await this.s3.write(key, bytes, { type: "application/octet-stream" });
  }

  /** Bun's client has no copy of its own, so the bytes are read from one key and written to the other. */
  async copy(fromKey: string, toKey: string): Promise<void> {
    await this.s3.write(toKey, this.s3.file(fromKey), { type: "application/octet-stream" });
  }

  async stat(key: string): Promise<{ size: number; etag: string } | null> {
    try {
      const stat = await this.s3.stat(key);
      return { size: stat.size, etag: stat.etag };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "NoSuchKey" || code === "NotFound") return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    await this.s3.delete(key);
  }
}

/** The data folder itself, for a Portico with no bucket: each key is a path inside. Folders are made on the first write. */
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

  /** The databases share this disk, and a full disk stops Portico, so files never take the last of it. */
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
    mkdirSync(dirname(this.path(key)), { recursive: true });
    return `${this.path(key)}.part`;
  }

  /** The finished upload takes the file's place in one step. */
  keep(key: string): void {
    renameSync(this.partPath(key), this.path(key));
  }

  discardPart(key: string): void {
    rmSync(`${this.path(key)}.part`, { force: true });
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    mkdirSync(dirname(this.path(key)), { recursive: true });
    await Bun.write(this.path(key), bytes);
  }

  /** Written beside the new place first, so a copy cut short never looks like the whole file. */
  async copy(fromKey: string, toKey: string): Promise<void> {
    const part = this.partPath(toKey);
    copyFileSync(this.path(fromKey), part);
    renameSync(part, this.path(toKey));
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

/** The configured bucket, or the data folder. Either way, each workspace's files sit under the workspace's own key prefix. */
export function fileStoreFor(config: { dataDir: string; files: BucketConfig | null }): FileStore {
  return config.files ? new BucketStore(config.files) : new FolderStore(config.dataDir);
}
