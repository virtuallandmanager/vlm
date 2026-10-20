import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { config } from '../config.js'
import { assertWorldSlug } from './worlds-db.js'

export type S3Like = {
  list(prefix: string): Promise<string[]>
  deleteMany(keys: string[]): Promise<void>
}

const DELETE_BATCH = 1000

/** S3Like over the worlds R2 bucket, from HYPERFY_ASSETS_S3_URI (s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>). */
export function r2S3Like(uri = config.hyperfyAssetsS3Uri): S3Like {
  if (!uri) throw new Error('HYPERFY_ASSETS_S3_URI is not set')
  const u = new URL(uri)
  const bucket = u.pathname.replace(/^\/+|\/+$/g, '')
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${u.host}`,
    forcePathStyle: true,
    credentials: { accessKeyId: decodeURIComponent(u.username), secretAccessKey: decodeURIComponent(u.password) },
  })
  return {
    async list(prefix) {
      const keys: string[] = []
      let token: string | undefined
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key)
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return keys
    },
    async deleteMany(keys) {
      if (!keys.length) return
      const res = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }))
      if (res.Errors?.length) throw new Error(`failed to delete ${res.Errors.length} objects from the worlds bucket`)
    },
  }
}

/** Deletes every object under `<slug>/`; returns how many. */
export async function deleteWorldFiles(slug: string, s3: S3Like = r2S3Like()): Promise<number> {
  assertWorldSlug(slug)
  const prefix = `${slug}/`
  const keys = (await s3.list(prefix)).filter((k) => k.startsWith(prefix))
  for (let i = 0; i < keys.length; i += DELETE_BATCH) await s3.deleteMany(keys.slice(i, i + DELETE_BATCH))
  return keys.length
}
