import { config } from '../config'
import { S3Error } from './errors'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const MAX_SKEW_MS = 15 * 60 * 1000
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60

export type Credential = { accessKeyId: string, date: string, region: string, service: string }

type Signed = {
	credential: Credential
	signedHeaders: string[]
	signature: string
	amzDate: string
	payloadHash: string
	// Set for presigned URLs: how many seconds after amzDate the link stays valid.
	expires?: number
}

// How an aws-chunked upload is signed, from the x-amz-content-sha256 header.
export type StreamingMode = 'signed' | 'signed-trailer' | 'unsigned-trailer'

const STREAMING_MODES: Record<string, StreamingMode> = {
	'STREAMING-AWS4-HMAC-SHA256-PAYLOAD': 'signed',
	'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER': 'signed-trailer',
	'STREAMING-UNSIGNED-PAYLOAD-TRAILER': 'unsigned-trailer',
}

// What the body decoder needs to check each chunk: the request's own signature starts the chain.
export type StreamingContext = {
	mode: StreamingMode
	credential: Credential
	amzDate: string
	seedSignature: string
}

// Filled by checkAuth, read by the handler that decodes the body. Entries go away with the request.
const streaming = new WeakMap<Request, StreamingContext>()

export function streamingContext(req: Request): StreamingContext | undefined {
	return streaming.get(req)
}

// True when a header-signed request signed UNSIGNED-PAYLOAD, so its body is not covered by the signature.
// Presigned URLs always do this, because the link is made before the body exists, so they are not counted.
export function hasUnsignedHeaderPayload(req: Request): boolean {
	return req.headers.get('x-amz-content-sha256') === 'UNSIGNED-PAYLOAD' && !new URL(req.url).searchParams.has('X-Amz-Signature')
}

// True when the request carries a signature, in the Authorization header or in a presigned URL.
// A request with neither is anonymous: only a bucket policy can let it through.
export function isSignedRequest(req: Request): boolean {
	return req.headers.has('authorization') || new URL(req.url).searchParams.has('X-Amz-Signature')
}

export function checkAuth(req: Request): void {
	const url = new URL(req.url)
	if (url.searchParams.has('X-Amz-Signature')) {
		checkPresigned(req, url)
		return
	}

	const payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
	const mode = STREAMING_MODES[payloadHash]
	if (payloadHash.startsWith('STREAMING-') && !mode) {
		throw new S3Error('NotImplemented', 501, 'This streaming payload type is not supported.')
	}

	const header = req.headers.get('authorization')
	if (!header) throw new S3Error('AccessDenied', 403, 'Access Denied')

	const { credential, signedHeaders, signature } = parseAuthorization(header)
	const amzDate = req.headers.get('x-amz-date') ?? ''
	verify(req, { credential, signedHeaders, signature, amzDate, payloadHash })

	if (mode) streaming.set(req, { mode, credential, amzDate, seedSignature: signature })
}

// A presigned URL carries its signature in the query string and signs UNSIGNED-PAYLOAD,
// so whoever holds the link can act without the keys, until it expires.
function checkPresigned(req: Request, url: URL): void {
	const params = url.searchParams
	if (params.get('X-Amz-Algorithm') !== ALGORITHM) {
		throw new S3Error('AuthorizationQueryParametersError', 400, 'X-Amz-Algorithm only supports AWS4-HMAC-SHA256.')
	}
	const expires = Number(params.get('X-Amz-Expires'))
	if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_SECONDS) {
		throw new S3Error('AuthorizationQueryParametersError', 400, 'X-Amz-Expires must be between 1 and 604800 seconds.')
	}

	verify(req, {
		credential: parseCredential(params.get('X-Amz-Credential') ?? ''),
		signedHeaders: parseSignedHeaders(params.get('X-Amz-SignedHeaders') ?? ''),
		signature: params.get('X-Amz-Signature') ?? '',
		amzDate: params.get('X-Amz-Date') ?? '',
		payloadHash: 'UNSIGNED-PAYLOAD',
		expires,
	})
}

function verify(req: Request, signed: Signed): void {
	const { credential, signedHeaders, signature, amzDate, payloadHash, expires } = signed
	if (credential.accessKeyId !== config.accessKeyId) {
		throw new S3Error('InvalidAccessKeyId', 403, 'The AWS access key ID you provided does not exist in our records.')
	}
	if (credential.date !== amzDate.slice(0, 8)) {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}
	checkTiming(amzDate, expires)
	if (!payloadHash) {
		throw new S3Error('InvalidRequest', 400, 'Missing required header for this request: x-amz-content-sha256.')
	}

	const scope = `${credential.date}/${credential.region}/${credential.service}/aws4_request`
	const omitQuery = expires === undefined ? undefined : 'X-Amz-Signature'
	const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest(req, signedHeaders, payloadHash, omitQuery))].join('\n')
	const expected = signatureFor(config.secretAccessKey, credential, stringToSign)
	if (!safeEqual(expected, signature)) {
		throw new S3Error('SignatureDoesNotMatch', 403, 'The request signature we calculated does not match the signature you provided. Check your AWS secret access key and signing method.')
	}
}

// Header requests must be close to the server's clock. Presigned URLs are valid for their stated window instead.
function checkTiming(amzDate: string, expires?: number): void {
	const signedAt = parseAmzDate(amzDate)
	if (expires === undefined) {
		if (Math.abs(Date.now() - signedAt) > MAX_SKEW_MS) {
			throw new S3Error('RequestTimeTooSkewed', 403, `The difference between the request time and the server's time is too large.`)
		}
		return
	}
	if (Date.now() > signedAt + expires * 1000) {
		throw new S3Error('AccessDenied', 403, 'Request has expired')
	}
}

// The signing key is an HMAC chain over the date, region, service, and the literal "aws4_request".
export function signatureFor(secret: string, credential: Credential, stringToSign: string): string {
	const kDate = hmac(`AWS4${secret}`, credential.date)
	const kRegion = hmac(kDate, credential.region)
	const kService = hmac(kRegion, credential.service)
	const kSigning = hmac(kService, 'aws4_request')
	return new Bun.CryptoHasher('sha256', kSigning).update(stringToSign).digest('hex')
}

function parseAuthorization(header: string) {
	if (!header.startsWith(`${ALGORITHM} `)) {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}

	const fields = new Map(
		header
			.slice(ALGORITHM.length + 1)
			.split(', ')
			.map(part => part.split('=', 2) as [string, string]),
	)
	const signature = fields.get('Signature') ?? ''
	if (!signature) {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}

	return {
		credential: parseCredential(fields.get('Credential') ?? ''),
		signedHeaders: parseSignedHeaders(fields.get('SignedHeaders') ?? ''),
		signature,
	}
}

// Credential is "accessKeyId/date/region/s3/aws4_request".
function parseCredential(value: string): Credential {
	const [accessKeyId, date, region, service, terminator] = value.split('/')
	if (!accessKeyId || !date || !region || service !== 's3' || terminator !== 'aws4_request') {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}
	return { accessKeyId, date, region, service }
}

function parseSignedHeaders(value: string): string[] {
	const headers = value.split(';').filter(Boolean)
	if (!headers.length) {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}
	return headers.map(h => h.toLowerCase()).sort()
}

function canonicalRequest(req: Request, signedHeaders: string[], payloadHash: string, omitQuery?: string): string {
	const url = new URL(req.url)

	const query = [...url.searchParams]
		.filter(([k]) => k !== omitQuery)
		.map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
		.sort(([ak, av], [bk, bv]) => (ak === bk ? compare(av, bv) : compare(ak, bk)))
		.map(([k, v]) => `${k}=${v}`)
		.join('&')

	const headers = signedHeaders
		.map(name => `${name}:${(req.headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`)
		.join('')

	return [req.method, url.pathname, query, headers, signedHeaders.join(';'), payloadHash].join('\n')
}

function parseAmzDate(value: string): number {
	const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
	if (!m) throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number]
	return Date.UTC(year, month - 1, day, hour, minute, second)
}

// AWS encodes everything except unreserved characters, including ! ' ( ) and *.
function rfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

export function sha256Hex(data: string | Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

function hmac(key: string | Uint8Array, data: string): Uint8Array {
	return new Bun.CryptoHasher('sha256', key).update(data).digest()
}

// Constant-time comparison, so the time taken doesn't reveal how much of the signature matched.
export function safeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a)
	const right = new TextEncoder().encode(b)
	if (left.length !== right.length) return false
	let diff = 0
	for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!
	return diff === 0
}
