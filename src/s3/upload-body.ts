import { config } from '../config'
import { hasUnsignedHeaderPayload, streamingContext } from './auth'
import { announcedTrailers, decodeChunked, decodedContentLength } from './chunked'
import { S3Error } from './errors'

// The body hash the client signed. UNSIGNED-PAYLOAD (and presigned requests) has no hash to check against.
export function signedPayloadHash(req: Request): string | undefined {
	const value = req.headers.get('x-amz-content-sha256') ?? ''
	return /^[0-9a-f]{64}$/i.test(value) ? value : undefined
}

// Over plain HTTP nothing else protects a body, so it must be covered by the signature: a real SHA-256 or aws-chunked.
// The unsigned-trailer form of aws-chunked is accepted too. It has only a checksum, which catches corruption but not
// tampering (see the README).
export function assertSignedBody(req: Request): void {
	if (hasUnsignedHeaderPayload(req)) {
		throw new S3Error('InvalidRequest', 400, 'Uploads must sign the body: send its SHA-256 in x-amz-content-sha256, or use aws-chunked streaming. UNSIGNED-PAYLOAD is only accepted on presigned URLs.')
	}
}

// The bytes of an object upload (PutObject or UploadPart), plus the SHA-256 the writer must check them against.
// An aws-chunked body is longer than the file it carries, so the size limit applies to the decoded size.
export function uploadBody(req: Request, resource: string): { body: AsyncIterable<Uint8Array> | null, sha256?: string } {
	assertSignedBody(req)

	const streaming = streamingContext(req)
	const decodedLength = streaming ? decodedContentLength(req) : undefined
	const declaredSize = decodedLength ?? Number(req.headers.get('content-length') ?? 0)
	if (declaredSize > config.maxFileBytes) {
		throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.', resource)
	}

	const body = streaming && decodedLength !== undefined
		? decodeChunked(req.body, streaming, { decodedLength, trailerNames: announcedTrailers(req) })
		: req.body
	return { body, sha256: signedPayloadHash(req) }
}
