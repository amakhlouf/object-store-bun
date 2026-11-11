import { buckets, objects, type ObjectRow } from '../db'
import { S3Error } from './errors'

// decodeURIComponent throws on a broken percent sequence such as "%E0%A4%A". That is the client's mistake, so it is
// reported as a 400 instead of escaping as an unexpected error.
function decode(value: string, onError: () => S3Error): string {
	try {
		return decodeURIComponent(value)
	} catch {
		throw onError()
	}
}

// The x-amz-copy-source header is "/bucket/key" or "bucket/key", URL-encoded.
export function parseCopySource(header: string): { bucket: string, key: string } {
	const path = decode(header, () => new S3Error('InvalidArgument', 400, 'Invalid copy source object key.')).replace(/^\//, '')
	const slash = path.indexOf('/')
	if (slash <= 0 || slash === path.length - 1) {
		throw new S3Error('InvalidArgument', 400, 'Invalid copy source object key.')
	}
	return { bucket: path.slice(0, slash), key: path.slice(slash + 1) }
}

export function findObjectOrThrow(bucket: string, key: string): ObjectRow {
	const row = objects.get(bucket, key)
	if (!row) {
		throw new S3Error('NoSuchKey', 404, 'The specified key does not exist.', `/${bucket}/${key}`)
	}
	return row
}

// The object key from the request path: everything after the bucket name.
export function objectKey(req: Request): string {
	const path = new URL(req.url).pathname
	return decode(path.slice(path.indexOf('/', 1) + 1), () => new S3Error('InvalidURI', 400, "Couldn't parse the specified URI."))
}

export function assertBucketExists(bucket: string): void {
	const exists = buckets.exists(bucket)
	if (!exists) {
		throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist.', `/${bucket}`)
	}
}
