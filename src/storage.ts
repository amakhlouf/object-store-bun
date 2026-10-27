import type { BunFile } from 'bun'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { config } from './config'
import { S3Error } from './s3/errors'

export function objectPath(dataDir: string, bucket: string, key: string): string {
	const bucketRoot = resolve(dataDir, bucket)
	const path = resolve(bucketRoot, key)
	if (!path.startsWith(bucketRoot + sep) || path === bucketRoot) {
		throw new S3Error('InvalidArgument', 400, 'Invalid Argument')
	}
	return path
}

export async function writeObject(path: string, body: ReadableStream<Uint8Array> | null): Promise<{ etag: string, size: number }> {
	await mkdir(dirname(path), { recursive: true })

	const hasher = new Bun.CryptoHasher('md5')
	const writer = Bun.file(path).writer()
	let size = 0

	try {
		if (body) {
			for await (const chunk of body) {
				size += chunk.byteLength
				if (size > config.maxFileBytes) {
					throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.')
				}
				hasher.update(chunk)
				await writer.write(chunk)
			}
		}
	} catch (error) {
		await writer.end()
		await rm(path, { force: true })
		throw error
	}

	await writer.end()
	return { etag: hasher.digest('hex'), size }
}

export function readObject(path: string): BunFile {
	return Bun.file(path)
}

export async function deleteObjectFile(path: string): Promise<void> {
	await rm(path, { force: true })
}
