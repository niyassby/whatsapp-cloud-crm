import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

/** S3_* settings, shared by the API and the worker. */
export const s3EnvShape = {
  S3_ENDPOINT: z.url().optional(),
  /** Address browsers use for signed links, when it differs from S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().default('wacrm-media'),
  S3_ACCESS_KEY_ID: z.string().default('localdev'),
  S3_SECRET_ACCESS_KEY: z.string().default('localdev-secret'),
};

export function s3ConfigFromEnv(env: {
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}): S3StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
}

/** Object storage used for message media. S3-compatible: R2, S3, SeaweedFS locally. */
export interface ObjectStorage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Short-lived download link, so the browser fetches media without an API token. */
  signedUrl(
    key: string,
    opts: { expiresIn: number; filename?: string | null; inline: boolean },
  ): Promise<string>;
}

export interface S3StorageConfig {
  endpoint?: string;
  /** Address browsers use for signed links, when it differs from `endpoint`. */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    const build = (endpoint?: string) =>
      new S3Client({
        endpoint,
        region: config.region,
        // Path-style works everywhere a custom endpoint is used (SeaweedFS, R2).
        forcePathStyle: Boolean(endpoint),
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    this.client = build(config.endpoint);
    this.signer = build(config.publicEndpoint ?? config.endpoint);
  }

  /** Development convenience: create the bucket if it is missing. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    }
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  signedUrl(
    key: string,
    opts: { expiresIn: number; filename?: string | null; inline: boolean },
  ): Promise<string> {
    const name = (opts.filename ?? 'file').replace(/[^\w.\- ]/g, '_');
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        // Customer-supplied files never render as a page on the storage origin.
        ResponseContentDisposition: opts.inline ? 'inline' : `attachment; filename="${name}"`,
      }),
      { expiresIn: opts.expiresIn },
    );
  }
}

/** Test double. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }

  async get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`No such object: ${key}`);
    return found.bytes;
  }

  async signedUrl(key: string, opts: { expiresIn: number }): Promise<string> {
    return `https://storage.test/${key}?expires=${opts.expiresIn}`;
  }
}

/** Keys are namespaced by org and message, and never contain client-supplied text. */
export const mediaKey = (orgId: string, messageId: string) => `orgs/${orgId}/messages/${messageId}`;
