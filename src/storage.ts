import type { BunFile } from 'bun'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { config } from './config'
import { S3Error } from './s3/errors'

// A key becomes a path inside the bucket folder, so two keys must never name the same file. Dot segments ("x/../y"),
// empty segments ("a//b", a leading or trailing slash) all resolve onto another key's path, so they are refused.
function assertPlainKey(key: string): void {
	if (key.includes('\0') || key.split('/').some(part => part === '' || part === '.' || part === '..')) {
		throw new S3Error('InvalidArgument', 400, 'Object keys can not have empty, "." or ".." parts, a leading or trailing slash, or a null character.')
	}
}

// Buckets live in their own folder, so a bucket name can't collide with storage.db or logs/.
export function objectPath(bucketsDir: string, bucket: string, key: string): string {
	assertPlainKey(key)
	const bucketRoot = resolve(bucketsDir, bucket)
	const path = resolve(bucketRoot, key)
	if (!path.startsWith(bucketRoot + sep) || path === bucketRoot) {
		throw new S3Error('InvalidArgument', 400, 'Invalid Argument')
	}
	return path
}

// Keys are files, so "a" can't exist next to "a/b": one would have to be both a file and a folder.
const FILE_FOLDER_CONFLICT = new Set(['EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY'])

function asKeyConflict(error: unknown): S3Error | undefined {
	const code = (error as { code?: string } | null)?.code
	if (code && FILE_FOLDER_CONFLICT.has(code)) {
		return new S3Error('InvalidArgument', 400, 'A key can not be both an object and the folder of another key, such as "a" next to "a/b".')
	}
}

// expectedSha256 is the hash the client signed in x-amz-content-sha256. When given, the body must match it.
export async function writeObject(path: string, body: AsyncIterable<Uint8Array> | null, expectedSha256?: string): Promise<{ etag: string, size: number }> {
	try {
		await mkdir(dirname(path), { recursive: true })
	} catch (error) {
		throw asKeyConflict(error) ?? error
	}

	// Write to a temp file first, so a failed upload never touches the object already at this path. The temp files live
	// in their own folder, so no object key can ever look like one.
	await mkdir(config.tmpDir, { recursive: true })
	const temp = join(config.tmpDir, `${crypto.randomUUID()}.tmp`)
	const hasher = new Bun.CryptoHasher('md5')
	const payloadHasher = expectedSha256 ? new Bun.CryptoHasher('sha256') : undefined
	const writer = Bun.file(temp).writer()
	let size = 0

	try {
		if (body) {
			for await (const chunk of body) {
				size += chunk.byteLength
				if (size > config.maxFileBytes) {
					throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.')
				}
				hasher.update(chunk)
				payloadHasher?.update(chunk)
				await writer.write(chunk)
			}
		}
		if (payloadHasher && payloadHasher.digest('hex') !== expectedSha256?.toLowerCase()) {
			throw new S3Error('XAmzContentSHA256Mismatch', 400, "The provided 'x-amz-content-sha256' header does not match what was computed.")
		}
		await writer.end()
	} catch (error) {
		// Closing can fail too, for example on a full disk. That must not hide the real error or keep the temp file.
		try {
			await writer.end()
		} catch {}
		await rm(temp, { force: true })
		throw error
	}

	// rename replaces the old file in one step, so readers see either the old object or the new one.
	try {
		await rename(temp, path)
	} catch (error) {
		await rm(temp, { force: true })
		throw asKeyConflict(error) ?? error
	}
	return { etag: hasher.digest('hex'), size }
}

// Files left in the temp folder by a crash. Call it at start-up, before any request can be writing.
export async function clearTempFiles(): Promise<void> {
	await rm(config.tmpDir, { recursive: true, force: true })
}

export function readObject(path: string): BunFile {
	return Bun.file(path)
}

export async function deleteObjectFile(path: string): Promise<void> {
	await rm(path, { force: true })
}
