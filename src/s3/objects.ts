import type { BunRequest } from 'bun'
import { config } from '../config'
import { objects, type ObjectRow } from '../db'
import { deleteObjectFile, objectPath, readObject, writeObject } from '../storage'
import { createBucket, deleteBucket, headBucket } from './buckets'
import { assertBucketExists, findObjectOrThrow, objectKey, parseCopySource } from './lookup'
import { abortMultipartUpload, hasUploadId, isPartUpload, listMultipartUploads, listParts, uploadPart } from './multipart'
import { xmlResponse } from './responses'
import { uploadBody } from './upload-body'

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
	const { etag, size } = await writeObject(objectPath(config.bucketsDir, bucket, key), body, sha256)
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

// PUT with an x-amz-copy-source header copies an existing object. The request has no body.
async function copyObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	const source = parseCopySource(req.headers.get('x-amz-copy-source') ?? '')
	assertBucketExists(source.bucket)
	const row = findObjectOrThrow(source.bucket, source.key)

	const { etag, size } = await writeObject(
		objectPath(config.bucketsDir, bucket, key),
		readObject(objectPath(config.bucketsDir, source.bucket, source.key)).stream(),
	)
	const lastModified = new Date().toISOString()
	objects.upsert({ bucket, key, size, etag, content_type: row.content_type, last_modified: lastModified })

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
		headers: objectHeaders(row),
	})
}

export function headObject(req: BunRequest<'/:bucket/*'>): Response {
	if (!objectKey(req)) return headBucket(req)

	const row = findObjectOrThrow(req.params.bucket, objectKey(req))
	return new Response(null, { headers: objectHeaders(row) })
}

export async function deleteObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	if (!objectKey(req)) return deleteBucket(req)
	if (hasUploadId(req)) return abortMultipartUpload(req)

	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)

	objects.remove(bucket, key)
	await deleteObjectFile(objectPath(config.bucketsDir, bucket, key))

	return new Response(null, { status: 204 })
}

export function listObjects(req: BunRequest<'/:bucket'>): Response {
	if (new URL(req.url).searchParams.has('uploads')) return listMultipartUploads(req)

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
	// max-keys=0 is an empty page, not a truncated one: there would be no key to use as the continuation token.
	const truncated = maxKeys > 0 && rows.length > maxKeys

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

function objectHeaders(row: ObjectRow): Record<string, string> {
	return {
		'Content-Type': row.content_type,
		'Content-Length': String(row.size),
		ETag: `"${row.etag}"`,
		'Last-Modified': new Date(row.last_modified).toUTCString(),
		'Accept-Ranges': 'bytes',
	}
}

