import type { BunRequest } from 'bun'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config'
import { objects, uploads, type PartRow, type UploadRow } from '../db'
import { log } from '../log'
import { objectPath, readObject, writeObject } from '../storage'
import { streamingContext } from './auth'
import { S3Error } from './errors'
import { withKeyLock } from './key-lock'
import { assertBucketExists, findObjectOrThrow, objectKey, parseCopySource } from './lookup'
import { xmlResponse } from './responses'
import { assertSignedBody, signedPayloadHash, uploadBody } from './upload-body'
import { withUploadLock } from './upload-lock'

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/'
const OWNER = { ID: 'local', DisplayName: 'local' }
const MAX_LIST_ENTRIES = 1000
// Rows read from SQLite at a time while building a ListMultipartUploads page.
const LIST_BATCH_SIZE = 500
const ORPHAN_GRACE_MS = 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const MAX_PART_NUMBER = 10_000
// S3's rule: every part except the last must be at least 5 MiB. It doesn't depend on MAX_FILE_BYTES.
export const MIN_PART_BYTES = 5 * 1024 * 1024
const MAX_COMPLETE_BODY_BYTES = 1024 * 1024

export const hasUploadId = (req: Request): boolean => new URL(req.url).searchParams.has('uploadId')

// Either query parameter means an UploadPart request. uploadPart() insists on both, so a PUT that has only one is
// rejected, instead of falling through to PutObject and overwriting the object at that key.
export function isPartUpload(req: Request): boolean {
	const query = new URL(req.url).searchParams
	return query.has('uploadId') || query.has('partNumber')
}

// POST /bucket/key?uploads starts an upload. POST /bucket/key?uploadId=X finishes it.
export async function postObject(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const query = new URL(req.url).searchParams
	if (objectKey(req) && query.has('uploads')) return createMultipartUpload(req)
	if (objectKey(req) && query.has('uploadId')) return completeMultipartUpload(req)
	throw new S3Error('NotImplemented', 501, 'This operation is not supported.')
}

function createMultipartUpload(req: BunRequest<'/:bucket/*'>): Response {
	const bucket = req.params.bucket
	const key = objectKey(req)
	assertBucketExists(bucket)
	objectPath(config.bucketsDir, bucket, key) // rejects keys that would leave the bucket folder, before any part is stored

	const upload: UploadRow = {
		upload_id: crypto.randomUUID().replaceAll('-', ''),
		bucket,
		key,
		content_type: req.headers.get('content-type') ?? 'application/octet-stream',
		created_at: new Date().toISOString(),
	}
	uploads.create(upload)

	return xmlResponse({
		InitiateMultipartUploadResult: { '@xmlns': XMLNS, Bucket: bucket, Key: key, UploadId: upload.upload_id },
	})
}

export async function uploadPart(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const query = new URL(req.url).searchParams
	if (!query.has('uploadId') || !query.has('partNumber')) {
		throw new S3Error('InvalidArgument', 400, 'UploadPart requires both the uploadId and the partNumber query parameters.')
	}
	if (req.headers.has('x-amz-copy-source')) return uploadPartCopy(req)

	const number = parsePartNumber(query.get('partNumber'))
	const { body, sha256 } = uploadBody(req, `/${req.params.bucket}/${objectKey(req)}`)

	// Parts share the upload's lock, so an abort, complete, or expiry waits for a part that is being written.
	return withUpload(req, false, async upload => {
		assertBucketExists(upload.bucket)
		const { etag, size } = await writeObject(partPath(upload, number), body, sha256)
		uploads.putPart({ upload_id: upload.upload_id, part_number: number, size, etag })

		return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } })
	})
}

async function completeMultipartUpload(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	// The parts list is read before taking the lock, so a slow client does not hold up the upload.
	const requested = parseCompleteBody(await readSignedText(req))

	// Alone on the upload from here on: no part can change and no abort or second Complete can delete the files.
	return withUpload(req, true, async upload => {
		assertBucketExists(upload.bucket)
		const stored = new Map(uploads.parts(upload.upload_id).map(part => [part.part_number, part]))

		let previous = 0
		const chosen: PartRow[] = []
		for (const { number, etag } of requested) {
			if (number <= previous) {
				throw new S3Error('InvalidPartOrder', 400, 'The list of parts was not in ascending order. The parts list must be specified in order by part number.')
			}
			previous = number
			const part = stored.get(number)
			// The file must still be the one the database describes. A crash between replacing a part and recording it would differ.
			const onDisk = await stat(partPath(upload, number)).catch(() => undefined)
			if (!part || part.etag !== etag || onDisk?.size !== part.size) {
				throw new S3Error('InvalidPart', 400, "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.")
			}
			chosen.push(part)
		}

		const resource = `/${upload.bucket}/${upload.key}`
		if (chosen.slice(0, -1).some(part => part.size < MIN_PART_BYTES)) {
			throw new S3Error('EntityTooSmall', 400, 'Your proposed upload is smaller than the minimum allowed size. Each part must be at least 5 MB, except the last part.', resource)
		}
		if (chosen.reduce((total, part) => total + part.size, 0) > config.maxFileBytes) {
			throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.', resource)
		}

		// The parts are joined into a temp file and renamed into place, like any other write, so a failure keeps the old object.
		const etag = multipartEtag(chosen)
		await withKeyLock(upload.bucket, upload.key, async () => {
			const { size } = await writeObject(
				objectPath(config.bucketsDir, upload.bucket, upload.key),
				concatParts(chosen.map(part => partPath(upload, part.part_number))),
			)
			objects.upsert({
				bucket: upload.bucket,
				key: upload.key,
				size,
				etag,
				content_type: upload.content_type,
				last_modified: new Date().toISOString(),
			})
		})
		await discardUpload(upload)

		return xmlResponse({
			CompleteMultipartUploadResult: { '@xmlns': XMLNS, Location: resource, Bucket: upload.bucket, Key: upload.key, ETag: `"${etag}"` },
		})
	})
}

export function abortMultipartUpload(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	return withUpload(req, true, async upload => {
		await discardUpload(upload)
		return new Response(null, { status: 204 })
	})
}

const noSuchUpload = () =>
	new S3Error('NoSuchUpload', 404, 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.')

// The upload must exist and belong to the bucket and key in the request path. The ID only ever names a folder
// through the database row, so a made-up ID can't point anywhere else.
function findUpload(req: BunRequest<'/:bucket/*'>): UploadRow {
	const row = uploads.get(new URL(req.url).searchParams.get('uploadId') ?? '')
	if (!row || row.bucket !== req.params.bucket || row.key !== objectKey(req)) throw noSuchUpload()
	return row
}

// Runs the task with the upload locked. The upload is looked up again once the lock is held, because it may have been
// aborted, completed, or expired while this request waited.
async function withUpload<T>(req: BunRequest<'/:bucket/*'>, exclusive: boolean, task: (upload: UploadRow) => Promise<T>): Promise<T> {
	const found = findUpload(req)
	return withUploadLock(found.upload_id, exclusive, async () => {
		const upload = uploads.get(found.upload_id)
		if (!upload) throw noSuchUpload()
		return task(upload)
	})
}

function partPath(upload: UploadRow, partNumber: number): string {
	return join(config.uploadsDir, upload.upload_id, String(partNumber))
}

async function discardUpload(upload: UploadRow): Promise<void> {
	uploads.remove(upload.upload_id)
	await rm(join(config.uploadsDir, upload.upload_id), { recursive: true, force: true })
}

// Only digits are converted: Number('') is 0 and Number('1e3') is 1000. A number with leading zeros is the same part ('01' is 1).
function parsePartNumber(value: string | null): number {
	const number = value !== null && /^\d+$/.test(value) ? Number(value) : 0
	if (number < 1 || number > MAX_PART_NUMBER) {
		throw new S3Error('InvalidArgument', 400, `Part number must be an integer between 1 and ${MAX_PART_NUMBER}, inclusive.`)
	}
	return number
}

// Like an upload body, the list of parts must be covered by the signature: changing it could drop or reorder parts.
async function readSignedText(req: Request): Promise<string> {
	assertSignedBody(req)
	if (streamingContext(req)) throw new S3Error('NotImplemented', 501, 'Chunked bodies are not supported for this request.')

	const tooLarge = () => new S3Error('EntityTooLarge', 400, 'Your request body is too large.')
	if (Number(req.headers.get('content-length') ?? 0) > MAX_COMPLETE_BODY_BYTES) throw tooLarge()

	// Read no more than the limit. A body with no length, or a wrong one, must not be buffered whole before it is checked.
	const chunks: Uint8Array[] = []
	let length = 0
	if (req.body) {
		for await (const chunk of req.body) {
			length += chunk.byteLength
			if (length > MAX_COMPLETE_BODY_BYTES) throw tooLarge()
			chunks.push(chunk)
		}
	}
	const bytes = Buffer.concat(chunks)

	const signed = signedPayloadHash(req)
	if (signed && new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== signed.toLowerCase()) {
		throw new S3Error('XAmzContentSHA256Mismatch', 400, "The provided 'x-amz-content-sha256' header does not match what was computed.")
	}
	return new TextDecoder().decode(bytes)
}

// <CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"..."</ETag></Part>...</CompleteMultipartUpload>
function parseCompleteBody(xml: string): { number: number, etag: string }[] {
	const malformed = () => new S3Error('MalformedXML', 400, 'The XML you provided was not well-formed or did not validate against our published schema.')

	const parts: { number: number, etag: string }[] = []
	for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
		const number = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(match[1]!)?.[1]
		const etag = /<ETag>\s*(?:"|&quot;)?([0-9a-fA-F]+)(?:"|&quot;)?\s*<\/ETag>/.exec(match[1]!)?.[1]
		if (!number || !etag) throw malformed()
		parts.push({ number: Number(number), etag: etag.toLowerCase() })
	}
	if (!parts.length) throw malformed()
	return parts
}

// S3's multipart ETag: the MD5 of the parts' binary MD5s joined together, then "-" and the part count.
function multipartEtag(parts: PartRow[]): string {
	const hasher = new Bun.CryptoHasher('md5')
	for (const part of parts) hasher.update(Buffer.from(part.etag, 'hex'))
	return `${hasher.digest('hex')}-${parts.length}`
}

async function* concatParts(paths: string[]): AsyncGenerator<Uint8Array> {
	for (const path of paths) yield* Bun.file(path).stream()
}

// UploadPartCopy: the part is taken from an existing object, or from a byte range of it.
async function uploadPartCopy(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const number = parsePartNumber(new URL(req.url).searchParams.get('partNumber'))

	const source = parseCopySource(req.headers.get('x-amz-copy-source') ?? '')
	assertBucketExists(source.bucket)
	const row = findObjectOrThrow(source.bucket, source.key)
	const range = parseCopyRange(req.headers.get('x-amz-copy-source-range'), row.size)

	return withUpload(req, false, async upload => {
		assertBucketExists(upload.bucket)
		const file = readObject(objectPath(config.bucketsDir, source.bucket, source.key))
		const { etag, size } = await writeObject(partPath(upload, number), (range ? file.slice(range.start, range.end + 1) : file).stream())
		uploads.putPart({ upload_id: upload.upload_id, part_number: number, size, etag })

		return xmlResponse({ CopyPartResult: { '@xmlns': XMLNS, LastModified: new Date().toISOString(), ETag: `"${etag}"` } })
	})
}

// x-amz-copy-source-range is "bytes=first-last", both zero-based and inclusive, and within the source object.
function parseCopyRange(header: string | null, sourceSize: number): { start: number, end: number } | undefined {
	if (header === null) return undefined
	const match = /^bytes=(\d+)-(\d+)$/.exec(header.trim())
	if (!match) {
		throw new S3Error('InvalidArgument', 400, 'The x-amz-copy-source-range value must be of the form bytes=first-last.')
	}
	const start = Number(match[1])
	const end = Number(match[2])
	if (start > end || end >= sourceSize) {
		throw new S3Error('InvalidRequest', 400, 'The specified copy range is invalid for the source object size.')
	}
	return { start, end }
}

// ListParts: the parts uploaded so far, in part number order, a page at a time.
export async function listParts(req: BunRequest<'/:bucket/*'>): Promise<Response> {
	const upload = findUpload(req)
	const query = new URL(req.url).searchParams
	const marker = Number(query.get('part-number-marker') ?? 0)
	if (!Number.isInteger(marker) || marker < 0) {
		throw new S3Error('InvalidArgument', 400, 'part-number-marker must be a non-negative integer.')
	}
	const maxParts = pageSize(query.get('max-parts'))

	const rows = uploads.partsAfter(upload.upload_id, marker, maxParts + 1)
	const page = rows.slice(0, maxParts)
	// A page size of 0 is an empty page, not a truncated one: there would be no part to use as the next marker.
	const truncated = maxParts > 0 && rows.length > maxParts
	const parts = await Promise.all(page.map(async part => ({
		PartNumber: part.part_number,
		LastModified: await partTime(upload, part.part_number),
		ETag: `"${part.etag}"`,
		Size: part.size,
	})))

	return xmlResponse({
		ListPartsResult: {
			'@xmlns': XMLNS,
			Bucket: upload.bucket,
			Key: upload.key,
			UploadId: upload.upload_id,
			Initiator: OWNER,
			Owner: OWNER,
			StorageClass: 'STANDARD',
			PartNumberMarker: marker,
			NextPartNumberMarker: truncated ? page.at(-1)?.part_number : undefined,
			MaxParts: maxParts,
			IsTruncated: truncated,
			Part: parts,
		},
	})
}

// The part file's modification time stands in for when the part was uploaded.
async function partTime(upload: UploadRow, partNumber: number): Promise<string> {
	try {
		return (await stat(partPath(upload, partNumber))).mtime.toISOString()
	} catch {
		return upload.created_at
	}
}

// ListMultipartUploads: uploads in progress in a bucket, by key and then start time. A delimiter groups keys that share
// a prefix up to the delimiter, like ListObjectsV2 does.
export function listMultipartUploads(req: BunRequest<'/:bucket'>): Response {
	const bucket = req.params.bucket
	assertBucketExists(bucket)

	const query = new URL(req.url).searchParams
	const prefix = query.get('prefix') ?? ''
	const delimiter = query.get('delimiter') ?? ''
	const keyMarker = query.get('key-marker') ?? ''
	const uploadIdMarker = query.get('upload-id-marker') ?? ''
	const maxUploads = pageSize(query.get('max-uploads'))

	// The upload-id marker only means something together with the key marker, and only if it names an upload of that key.
	const markerRow = keyMarker && uploadIdMarker ? uploads.get(uploadIdMarker) : null
	const after = markerRow && markerRow.bucket === bucket && markerRow.key === keyMarker
		? { created_at: markerRow.created_at, upload_id: markerRow.upload_id }
		: undefined
	// A key marker that is a common prefix from the last page means: skip everything under it.
	const skipPrefix = delimiter && keyMarker.endsWith(delimiter) && keyMarker.startsWith(prefix) ? keyMarker : ''

	type Entry = { upload: UploadRow } | { commonPrefix: string }
	const entries: Entry[] = []
	let truncated = false
	let lastPrefix = ''

	// Rows are read in batches until the page is full, so a bucket with many uploads is never loaded whole. A page size
	// of 0 is an empty page, not a truncated one, so nothing is read for it.
	let cursorKey = keyMarker
	let cursorAfter = after
	scan: while (maxUploads > 0) {
		const rows = uploads.list(bucket, prefix, cursorKey, cursorAfter, LIST_BATCH_SIZE)
		for (const row of rows) {
			if (skipPrefix && row.key.startsWith(skipPrefix)) continue
			const rest = row.key.slice(prefix.length)
			const cut = delimiter ? rest.indexOf(delimiter) : -1
			const commonPrefix = cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : ''
			if (commonPrefix && commonPrefix === lastPrefix) continue
			if (entries.length === maxUploads) {
				truncated = true
				break scan
			}
			if (commonPrefix) {
				lastPrefix = commonPrefix
				entries.push({ commonPrefix })
			} else {
				entries.push({ upload: row })
			}
		}

		const lastRow = rows.at(-1)
		if (!lastRow || rows.length < LIST_BATCH_SIZE) break
		cursorKey = lastRow.key
		cursorAfter = { created_at: lastRow.created_at, upload_id: lastRow.upload_id }
	}

	const last = entries.at(-1)
	const listed = entries.flatMap(entry => 'upload' in entry ? [entry.upload] : [])
	return xmlResponse({
		ListMultipartUploadsResult: {
			'@xmlns': XMLNS,
			Bucket: bucket,
			KeyMarker: keyMarker,
			UploadIdMarker: uploadIdMarker,
			NextKeyMarker: truncated && last ? ('upload' in last ? last.upload.key : last.commonPrefix) : undefined,
			NextUploadIdMarker: truncated && last ? ('upload' in last ? last.upload.upload_id : '') : undefined,
			Prefix: prefix,
			Delimiter: delimiter || undefined,
			MaxUploads: maxUploads,
			IsTruncated: truncated,
			Upload: listed.map(upload => ({
				Key: upload.key,
				UploadId: upload.upload_id,
				Initiator: OWNER,
				Owner: OWNER,
				StorageClass: 'STANDARD',
				Initiated: upload.created_at,
			})),
			CommonPrefixes: entries.flatMap(entry => 'commonPrefix' in entry ? [{ Prefix: entry.commonPrefix }] : []),
		},
	})
}

// max-parts and max-uploads: default and largest page is 1000.
function pageSize(value: string | null): number {
	const requested = Number(value ?? MAX_LIST_ENTRIES)
	return Number.isInteger(requested) && requested >= 0 ? Math.min(requested, MAX_LIST_ENTRIES) : MAX_LIST_ENTRIES
}

// When the upload was started, or when its newest part was written, whichever is later (as a time in milliseconds).
// An upload that is still receiving parts is not abandoned, however long ago it started.
async function lastActivity(upload: UploadRow): Promise<number> {
	let latest = Date.parse(upload.created_at)
	for (const part of uploads.parts(upload.upload_id)) {
		const modified = (await stat(partPath(upload, part.part_number)).catch(() => undefined))?.mtimeMs
		if (modified !== undefined && modified > latest) latest = modified
	}
	return latest
}

// Aborts uploads with no activity for INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS, and removes part folders that no upload owns (left behind by a
// crash). Each upload is locked while it is checked and removed. Returns how many were removed.
export async function expireUploads(now = Date.now()): Promise<number> {
	let removed = 0

	if (config.incompleteUploadExpireAfterDays > 0) {
		const cutoff = now - config.incompleteUploadExpireAfterDays * 24 * 60 * 60 * 1000
		for (const candidate of uploads.startedBefore(new Date(cutoff).toISOString())) {
			const expired = await withUploadLock(candidate.upload_id, true, async () => {
				// It may be gone already, or a part may have arrived while this waited for the lock.
				const upload = uploads.get(candidate.upload_id)
				if (!upload || (await lastActivity(upload)) >= cutoff) return false
				await discardUpload(upload)
				return true
			})
			if (expired) removed++
		}
	}

	let names: string[]
	try {
		names = await readdir(config.uploadsDir)
	} catch {
		return removed // no uploads folder yet
	}
	for (const name of names) {
		if (uploads.get(name)) continue
		const folder = join(config.uploadsDir, name)
		const modified = (await stat(folder).catch(() => undefined))?.mtimeMs
		// The grace period keeps a folder that was only just created for a new upload.
		if (modified !== undefined && now - modified > ORPHAN_GRACE_MS) {
			await rm(folder, { recursive: true, force: true })
			removed++
		}
	}
	return removed
}

// Runs the cleanup at startup and then every hour. The timer does not keep the process alive.
export function startUploadSweeper(): void {
	const run = () => expireUploads()
		.then(removed => {
			if (removed) log(`removed ${removed} expired or leftover multipart upload(s)`)
		})
		.catch(error => log(`ERROR multipart cleanup failed: ${error instanceof Error ? error.message : String(error)}`))
	void run()
	setInterval(run, SWEEP_INTERVAL_MS).unref()
}
