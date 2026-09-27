import "server-only";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { env } from "@/env";
import { decryptBuffer, encryptBuffer, randomToken } from "./crypto";

/**
 * S3-compatible storage abstraction.
 * - LocalDiskStorage for development, S3Storage for AWS S3 / Cloudflare R2 / MinIO.
 * - Objects are encrypted (AES-256-GCM) before they leave the process, so neither the
 *   disk nor the bucket ever holds plaintext resumes.
 * - Keys are generated and opaque; files are served only through the authenticated
 *   download endpoint - never through permanent public URLs.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key");
  return key;
}

export class LocalDiskStorage implements StorageAdapter {
  private readonly root: string;
  constructor(dir: string) {
    // Resolve relative dirs against the monorepo root so dev servers and scripts agree.
    this.root = isAbsolute(dir) ? dir : resolve(process.cwd(), process.cwd().endsWith(`apps${sep}web`) ? "../.." : ".", dir);
  }
  private path(key: string) {
    const p = resolve(this.root, safeKey(key));
    if (!p.startsWith(this.root)) throw new Error("Invalid storage path");
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => undefined);
  }
  async deletePrefix(prefix: string): Promise<void> {
    await rm(join(this.root, safeKey(prefix)), { recursive: true, force: true });
  }
}

export class S3Storage implements StorageAdapter {
  constructor(
    private readonly bucket: string,
    private readonly clientOptions: { region: string; endpoint?: string; forcePathStyle?: boolean; accessKeyId?: string; secretAccessKey?: string },
  ) {}
  private async client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const o = this.clientOptions;
    return new S3Client({
      region: o.region,
      endpoint: o.endpoint || undefined,
      forcePathStyle: o.forcePathStyle,
      credentials: o.accessKeyId && o.secretAccessKey ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } : undefined,
    });
  }
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.client()).send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Empty object");
    return Buffer.from(bytes);
  }
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }
  async deletePrefix(prefix: string): Promise<void> {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const client = await this.client();
    let token: string | undefined;
    do {
      const list = await client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: safeKey(prefix), ContinuationToken: token }));
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objects.length) await client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }));
      token = list.NextContinuationToken;
    } while (token);
  }
  /** Short-lived signed URL (5 min). Returns ciphertext; only for server-to-server transfers. */
  async signedGetUrl(key: string, expiresInSec = 300): Promise<string> {
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([import("@aws-sdk/client-s3"), import("@aws-sdk/s3-request-presigner")]);
    return getSignedUrl(await this.client(), new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }), { expiresIn: expiresInSec });
  }
}

/** Encrypting wrapper - the only storage used by services. */
export class EncryptedStorage implements StorageAdapter {
  constructor(private readonly inner: StorageAdapter) {}
  put(key: string, data: Buffer, contentType: string) {
    return this.inner.put(key, encryptBuffer(data), contentType);
  }
  async get(key: string) {
    return decryptBuffer(await this.inner.get(key));
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  deletePrefix(prefix: string) {
    return this.inner.deletePrefix(prefix);
  }
}

let storage: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (storage) return storage;
  const e = env();
  const inner =
    e.STORAGE_DRIVER === "s3"
      ? new S3Storage(e.S3_BUCKET!, {
          region: e.S3_REGION,
          endpoint: e.S3_ENDPOINT,
          forcePathStyle: e.S3_FORCE_PATH_STYLE,
          accessKeyId: e.S3_ACCESS_KEY_ID,
          secretAccessKey: e.S3_SECRET_ACCESS_KEY,
        })
      : new LocalDiskStorage(e.STORAGE_LOCAL_DIR);
  storage = new EncryptedStorage(inner);
  return storage;
}

export function userPrefix(userId: string): string {
  return `users/${userId.replace(/[^a-zA-Z0-9_-]/g, "")}/`;
}

export function newResumeKey(userId: string): string {
  return `${userPrefix(userId)}resumes/${randomToken(18)}.bin`;
}
