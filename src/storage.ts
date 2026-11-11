import type { BunFile } from 'bun'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { config } from './config'
import { S3Error } from './s3/errors'

// Buckets live in their own folder, so a bucket name can't collide with storage.db or logs/.
export function objectPath(bucketsDir: string, bucket: string, key: string): string {
	const bucketRoot = resolve(bucketsDir, bucket)
	const path = resolve(bucketRoot, key)
	if (!path.startsWith(bucketRoot + sep) || path === bucketRoot) {
		throw new S3Error('InvalidArgument', 400, 'Invalid Argument')
	}
	return path
}

// expectedSha256 is the hash the client signed in x-amz-content-sha256. When given, the body must match it.
export async function writeObject(path: string, body: AsyncIterable<Uint8Array> | null, expectedSha256?: string): Promise<{ etag: string, size: number }> {
	await mkdir(dirname(path), { recursive: true })

	// Write to a temp file first, so a failed upload never touches the object already at this path.
	const temp = `${path}.${crypto.randomUUID()}.tmp`
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
		await writer.end()
		await rm(temp, { force: true })
		throw error
	}

	// rename replaces the old file in one step, so readers see either the old object or the new one.
	await rename(temp, path)
	return { etag: hasher.digest('hex'), size }
}

export function readObject(path: string): BunFile {
	return Bun.file(path)
}

export async function deleteObjectFile(path: string): Promise<void> {
	await rm(path, { force: true })
}
