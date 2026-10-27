import type { BunRequest } from 'bun'
import { config } from '../config'
import { buckets, objects, type ObjectRow } from '../db'
import { deleteObjectFile, objectPath, readObject, writeObject } from '../storage'
import { S3Error } from './errors'
import { xmlResponse } from './responses'

export async function putObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	const declaredSize = Number(req.headers.get('content-length') ?? 0)
	if (declaredSize > config.maxFileBytes) {
		throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.', `/${bucket}/${key}`)
	}

	const { etag, size } = await writeObject(objectPath(config.dataDir, bucket, key), req.body)
	objects.upsert({
		bucket,
		key,
		size,
		etag,
		content_type: req.headers.get('content-type') ?? 'application/octet-stream',
		last_modified: new Date().toISOString(),
	})

	return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } })
}

export function getObject(req: BunRequest<'/:bucket/*'>): Response {
	const bucket = req.params.bucket
	const key = objectKey(req)
	const row = findObjectOrThrow(bucket, key)

	return new Response(readObject(objectPath(config.dataDir, bucket, key)), {
		headers: objectHeaders(row),
	})
}

export function headObject(req: BunRequest<'/:bucket/*'>): Response {
	const row = findObjectOrThrow(req.params.bucket, objectKey(req))
	return new Response(null, { headers: objectHeaders(row) })
}

export async function deleteObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	objects.remove(bucket, key)
	await deleteObjectFile(objectPath(config.dataDir, bucket, key))

	return new Response(null, { status: 204 })
}

export function listObjects(req: BunRequest<'/:bucket'>): Response {
	const bucket = req.params.bucket
	assertBucketExists(bucket)

	const url = new URL(req.url)
	const prefix = url.searchParams.get('prefix') ?? ''
	const delimiter = url.searchParams.get('delimiter') ?? ''
	const requested = Number(url.searchParams.get('max-keys') ?? 1000)
	const maxKeys = Number.isInteger(requested) && requested >= 0 ? Math.min(requested, 1000) : 1000
	const token = url.searchParams.get('continuation-token')
	const after = token ? Buffer.from(token, 'base64url').toString() : ''

	const rows = objects.list(bucket, prefix, after, maxKeys + 1)
	const page = rows.slice(0, maxKeys)
	const truncated = rows.length > maxKeys

	const contents: object[] = []
	const commonPrefixes = new Set<string>()
	for (const row of page) {
		const rest = row.key.slice(prefix.length)
		const cut = delimiter ? rest.indexOf(delimiter) : -1
		if (cut >= 0) {
			commonPrefixes.add(prefix + rest.slice(0, cut + delimiter.length))
		} else {
			contents.push({
				Key: row.key,
				LastModified: row.last_modified,
				ETag: `"${row.etag}"`,
				Size: row.size,
				StorageClass: 'STANDARD',
			})
		}
	}

	const last = page.at(-1)?.key
	return xmlResponse({
		ListBucketResult: {
			'@xmlns': 'http://s3.amazonaws.com/doc/2006-03-01/',
			Name: bucket,
			Prefix: prefix,
			Delimiter: delimiter || undefined,
			MaxKeys: maxKeys,
			KeyCount: contents.length + commonPrefixes.size,
			IsTruncated: truncated,
			ContinuationToken: token || undefined,
			NextContinuationToken: truncated && last ? Buffer.from(last).toString('base64url') : undefined,
			Contents: contents,
			CommonPrefixes: [...commonPrefixes].map(p => ({ Prefix: p })),
		},
	})
}

function objectKey(req: Request): string {
	const path = new URL(req.url).pathname
	return decodeURIComponent(path.slice(path.indexOf('/', 1) + 1))
}

function objectHeaders(row: ObjectRow): Record<string, string> {
	return {
		'Content-Type': row.content_type,
		'Content-Length': String(row.size),
		ETag: `"${row.etag}"`,
		'Last-Modified': new Date(row.last_modified).toUTCString(),
	}
}

function findObjectOrThrow(bucket: string, key: string): ObjectRow {
	const row = objects.get(bucket, key)
	if (!row) {
		throw new S3Error('NoSuchKey', 404, 'The specified key does not exist.', `/${bucket}/${key}`)
	}
	return row
}

function assertBucketExists(bucket: string): void {
	const exists = buckets.exists(bucket)
	if (!exists) {
		throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist.', `/${bucket}`)
	}
}
