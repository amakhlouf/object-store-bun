import { config } from '../config'
import { S3Error } from './errors'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const MAX_SKEW_MS = 15 * 60 * 1000

export type Credential = { accessKeyId: string, date: string, region: string, service: string }

export function checkAuth(req: Request): void {
	if (req.headers.get('x-amz-content-sha256')?.startsWith('STREAMING-')) {
		throw new S3Error('NotImplemented', 501, 'Chunked signed uploads are not supported yet.')
	}

	const header = req.headers.get('authorization')
	if (!header) throw new S3Error('AccessDenied', 403, 'Access Denied')

	const { credential, signedHeaders, signature } = parseAuthorization(header)
	if (credential.accessKeyId !== config.accessKeyId) {
		throw new S3Error('InvalidAccessKeyId', 403, 'The AWS access key ID you provided does not exist in our records.')
	}

	const amzDate = req.headers.get('x-amz-date') ?? ''
	if (credential.date !== amzDate.slice(0, 8)) {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}
	if (Math.abs(Date.now() - parseAmzDate(amzDate)) > MAX_SKEW_MS) {
		throw new S3Error('RequestTimeTooSkewed', 403, `The difference between the request time and the server's time is too large.`)
	}

	const payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
	if (!payloadHash) {
		throw new S3Error('InvalidRequest', 400, 'Missing required header for this request: x-amz-content-sha256.')
	}

	const scope = `${credential.date}/${credential.region}/${credential.service}/aws4_request`
	const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest(req, signedHeaders, payloadHash))].join('\n')
	const expected = signatureFor(config.secretAccessKey, credential, stringToSign)
	if (!safeEqual(expected, signature)) {
		throw new S3Error('SignatureDoesNotMatch', 403, 'The request signature we calculated does not match the signature you provided. Check your AWS secret access key and signing method.')
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
	const credentialParts = (fields.get('Credential') ?? '').split('/')
	const signedHeaders = (fields.get('SignedHeaders') ?? '').split(';').filter(Boolean)
	const signature = fields.get('Signature') ?? ''

	const [accessKeyId, date, region, service, terminator] = credentialParts
	if (!accessKeyId || !date || !region || service !== 's3' || terminator !== 'aws4_request' || !signedHeaders.length || !signature) {
		throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header you provided is invalid.')
	}

	return {
		credential: { accessKeyId, date, region, service } as Credential,
		signedHeaders: signedHeaders.map(h => h.toLowerCase()).sort(),
		signature,
	}
}

function canonicalRequest(req: Request, signedHeaders: string[], payloadHash: string): string {
	const url = new URL(req.url)

	const query = [...url.searchParams]
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

function sha256Hex(data: string): string {
	return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

function hmac(key: string | Uint8Array, data: string): Uint8Array {
	return new Bun.CryptoHasher('sha256', key).update(data).digest()
}

// Constant-time comparison, so the time taken doesn't reveal how much of the signature matched.
function safeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a)
	const right = new TextEncoder().encode(b)
	if (left.length !== right.length) return false
	let diff = 0
	for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!
	return diff === 0
}
