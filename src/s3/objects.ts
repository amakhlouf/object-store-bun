import type { BunRequest } from 'bun'
import { config } from '../config'
import { objects, type ObjectRow } from '../db'
import { deleteObjectFile, objectPath, readObject, writeObject } from '../storage'
import { getBucketPolicy, isPolicyRequest } from './bucket-policy'
import { createBucket, deleteBucket, headBucket } from './buckets'
import { assertBucketExists, findObjectOrThrow, objectKey, parseCopySource } from './lookup'
import { abortMultipartUpload, hasUploadId, isPartUpload, listMultipartUploads, listParts, uploadPart } from './multipart'
import { PUBLIC_CACHE_CONTROL } from './bucket-policy'
import { isSignedRequest } from './auth'
import { withKeyLock } from './key-lock'
import { xmlResponse } from './responses'
import { uploadBody } from './upload-body'

// How many rows one listing query reads.
const LIST_BATCH_SIZE = 500
// Sorts after every key that starts with a given prefix, so `key > prefix + AFTER_PREFIX` skips the whole prefix.
const AFTER_PREFIX = '\u{10FFFF}'

// Bucket requests can arrive with a trailing slash (PUT /bucket/), which the wildcard route catches with an empty key.
// The signature still covers the path with the slash, so only the dispatch changes here.
export async function putObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	if (!objectKey(req)) return createBucket(req)
	if (isPartUpload(req)) return uploadPart(req)
	if (req.headers.has('x-amz-copy-source')) return copyObject(req)

	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	const { body, sha256 } = uploadBody(req, `/${bucket}/${key}`)
	const path = objectPath(config.bucketsDir, bucket, key)
	const { etag } = await withKeyLock(bucket, key, async () => {
		const written = await writeObject(path, body, sha256)
		objects.upsert({
			bucket,
			key,
			size: written.size,
			etag: written.etag,
			content_type: req.headers.get('content-type') ?? 'application/octet-stream',
			last_modified: new Date().toISOString(),
		})
		return written
	})

	return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } })
}

// PUT with an x-amz-copy-source header copies an existing object. The request has no body.
async function copyObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	const source = parseCopySource(req.headers.get('x-amz-copy-source') ?? '')
	assertBucketExists(source.bucket)
	const row = findObjectOrThrow(source.bucket, source.key)

	const path = objectPath(config.bucketsDir, bucket, key)
	const sourcePath = objectPath(config.bucketsDir, source.bucket, source.key)
	const { etag, lastModified } = await withKeyLock(bucket, key, async () => {
		const written = await writeObject(path, readObject(sourcePath).stream())
		const modified = new Date().toISOString()
		objects.upsert({ bucket, key, size: written.size, etag: written.etag, content_type: row.content_type, last_modified: modified })
		return { etag: written.etag, lastModified: modified }
	})

	return xmlResponse({ CopyObjectResult: { LastModified: lastModified, ETag: `"${etag}"` } })
}

export function getObject(req: BunRequest<'/:bucket/*'>): Response | Promise<Response> {
	// Bucket listing requests can arrive with a trailing slash (GET /bucket/), which the wildcard route catches.
	if (!objectKey(req)) return listObjects(req)
	if (hasUploadId(req)) return listParts(req)

	const bucket = req.params.bucket
	const key = objectKey(req)
	const row = findObjectOrThrow(bucket, key)

	return new Response(readObject(objectPath(config.bucketsDir, bucket, key)), {
		headers: readHeaders(req, row),
	})
}

export function headObject(req: BunRequest<'/:bucket/*'>): Response {
	if (!objectKey(req)) return headBucket(req)

	const row = findObjectOrThrow(req.params.bucket, objectKey(req))
	return new Response(null, { headers: readHeaders(req, row) })
}

export async function deleteObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	if (!objectKey(req)) return deleteBucket(req)
	if (hasUploadId(req)) return abortMultipartUpload(req)

	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	// Checked first, so a key the server never stores can't make this delete another key's file.
	const path = objectPath(config.bucketsDir, bucket, key)
	await withKeyLock(bucket, key, async () => {
		objects.remove(bucket, key)
		await deleteObjectFile(path)
	})

	return new Response(null, { status: 204 })
}

export function listObjects(req: BunRequest<'/:bucket'>): Response {
	if (isPolicyRequest(req)) return getBucketPolicy(req)
	if (new URL(req.url).searchParams.has('uploads')) return listMultipartUploads(req)

	const bucket = req.params.bucket
	assertBucketExists(bucket)

	const url = new URL(req.url)
	const prefix = url.searchParams.get('prefix') ?? ''
	const delimiter = url.searchParams.get('delimiter') ?? ''
	const requested = Number(url.searchParams.get('max-keys') ?? 1000)
	const maxKeys = Number.isInteger(requested) && requested >= 0 ? Math.min(requested, 1000) : 1000
	const token = url.searchParams.get('continuation-token')
	const resumeFrom = token ? Buffer.from(token, 'base64url').toString() : ''
	// A token that ends with the delimiter names a common prefix, the last entry of the previous page. Continue after
	// everything under it, so the prefix is not listed again.
	const resumedAfterPrefix = delimiter !== '' && resumeFrom.endsWith(delimiter) && resumeFrom.startsWith(prefix)

	// Entries are keys and common prefixes, and max-keys counts both. Rows are read in batches until the page is full, and a
	// whole common prefix is skipped in one step, so a prefix with many keys costs one extra query, not one per key.
	const contents: ObjectRow[] = []
	const commonPrefixes: string[] = []
	let cursor = resumedAfterPrefix ? resumeFrom + AFTER_PREFIX : resumeFrom
	let lastEntry = ''
	let truncated = false
	// max-keys=0 is an empty page, not a truncated one: there would be no entry to use as the continuation token.
	scan: while (maxKeys > 0) {
		const rows = objects.list(bucket, prefix, cursor, LIST_BATCH_SIZE)
		for (const row of rows) {
			if (contents.length + commonPrefixes.length === maxKeys) {
				truncated = true
				break scan
			}
			const rest = row.key.slice(prefix.length)
			const cut = delimiter ? rest.indexOf(delimiter) : -1
			if (cut >= 0) {
				lastEntry = prefix + rest.slice(0, cut + delimiter.length)
				commonPrefixes.push(lastEntry)
				cursor = lastEntry + AFTER_PREFIX
				continue scan
			}
			contents.push(row)
			lastEntry = row.key
			cursor = row.key
		}
		if (rows.length < LIST_BATCH_SIZE) break
	}

	return xmlResponse({
		ListBucketResult: {
			'@xmlns': 'http://s3.amazonaws.com/doc/2006-03-01/',
			Name: bucket,
			Prefix: prefix,
			Delimiter: delimiter || undefined,
			MaxKeys: maxKeys,
			KeyCount: contents.length + commonPrefixes.length,
			IsTruncated: truncated,
			ContinuationToken: token || undefined,
			NextContinuationToken: truncated ? Buffer.from(lastEntry).toString('base64url') : undefined,
			Contents: contents.map(row => ({
				Key: row.key,
				LastModified: row.last_modified,
				ETag: `"${row.etag}"`,
				Size: row.size,
				StorageClass: 'STANDARD',
			})),
			CommonPrefixes: commonPrefixes.map(p => ({ Prefix: p })),
		},
	})
}

// Anonymous reads (allowed by a bucket policy) are cacheable. Signed reads keep their headers as before.
function readHeaders(req: Request, row: ObjectRow): Record<string, string> {
	const headers = objectHeaders(row)
	if (!isSignedRequest(req)) headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
	return headers
}

function objectHeaders(row: ObjectRow): Record<string, string> {
	return {
		'Content-Type': row.content_type,
		'Content-Length': String(row.size),
		ETag: `"${row.etag}"`,
		'Last-Modified': new Date(row.last_modified).toUTCString(),
		'Accept-Ranges': 'bytes',
	}
}

