import { config } from '../config'
import { safeEqual, sha256Hex, signatureFor, type StreamingContext } from './auth'
import { S3Error } from './errors'

// Decodes an aws-chunked upload body: "<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n" repeated, then a
// zero-size chunk, then optional trailers. Each signed chunk covers the previous chunk's signature, starting
// from the request's own signature, so a changed, dropped, or reordered chunk breaks the chain.

const MAX_LINE_BYTES = 4096
const EMPTY = new Uint8Array(0)
const EMPTY_SHA256 = sha256Hex('')
const TRAILER_SIGNATURE = 'x-amz-trailer-signature'
const CHECKSUM_PREFIX = 'x-amz-checksum-'
const decoder = new TextDecoder()

const incompleteBody = () => new S3Error('IncompleteBody', 400, 'The request body terminated unexpectedly.')
const lengthMismatch = () => new S3Error('IncompleteBody', 400, 'The number of bytes in the body does not match the x-amz-decoded-content-length header.')
const malformed = () => new S3Error('InvalidRequest', 400, 'The aws-chunked request body is malformed.')
const signatureMismatch = () => new S3Error('SignatureDoesNotMatch', 403, 'The chunk signature we calculated does not match the signature you provided.')

export type Checksum = { update(data: Uint8Array): void, digest(): string }

// Both CRC variants are table-driven and reflected; they differ only in the polynomial. The digest is base64.
function crcChecksum(polynomial: number): Checksum {
	const table = new Uint32Array(256)
	for (let i = 0; i < 256; i++) {
		let c = i
		for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ polynomial : c >>> 1
		table[i] = c >>> 0
	}
	let crc = 0xffffffff
	return {
		update(data) {
			for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
		},
		digest() {
			const out = Buffer.alloc(4)
			out.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
			return out.toString('base64')
		},
	}
}

// The checksum named by an x-amz-checksum-<algorithm> trailer, or undefined if it isn't supported.
export function checksumFor(algorithm: string): Checksum | undefined {
	switch (algorithm) {
		case 'crc32':
			return crcChecksum(0xedb88320)
		case 'crc32c':
			return crcChecksum(0x82f63b78)
		case 'sha1':
		case 'sha256': {
			const hasher = new Bun.CryptoHasher(algorithm)
			return { update: data => { hasher.update(data) }, digest: () => hasher.digest('base64') }
		}
		default:
			return undefined
	}
}

// The real file size. content-length counts the chunk framing too, so it can't be used for the size limit.
export function decodedContentLength(req: Request): number {
	const value = req.headers.get('x-amz-decoded-content-length')
	if (value === null) throw new S3Error('MissingContentLength', 411, 'You must provide the Content-Length HTTP header.')
	const length = Number(value)
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(length)) {
		throw new S3Error('InvalidArgument', 400, 'x-amz-decoded-content-length must be a non-negative integer.')
	}
	return length
}

// Trailer names the client announced, such as x-amz-checksum-crc32.
export function announcedTrailers(req: Request): string[] {
	return (req.headers.get('x-amz-trailer') ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
}

// Reads lines and exact byte counts from a stream without loading all of it.
class ByteReader {
	// Only read() is used, so a structural type avoids a clash between Bun's and Node's reader types.
	private reader: { read(): Promise<{ done: boolean, value?: Uint8Array }> }
	private buffer: Uint8Array = EMPTY

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader()
	}

	private async fill(): Promise<boolean> {
		const { done, value } = await this.reader.read()
		if (done || !value) return false
		if (this.buffer.length === 0) {
			this.buffer = value
		} else {
			const joined = new Uint8Array(this.buffer.length + value.length)
			joined.set(this.buffer)
			joined.set(value, this.buffer.length)
			this.buffer = joined
		}
		return true
	}

	// One line without its CRLF, or null if the stream ended cleanly before any more bytes.
	async readLineOrEnd(): Promise<string | null> {
		let from = 0
		for (;;) {
			const end = indexOfCrlf(this.buffer, from)
			if (end >= 0) {
				const line = decoder.decode(this.buffer.subarray(0, end))
				this.buffer = this.buffer.subarray(end + 2)
				return line
			}
			if (this.buffer.length > MAX_LINE_BYTES) throw malformed()
			from = Math.max(0, this.buffer.length - 1)
			if (!(await this.fill())) {
				if (this.buffer.length) throw incompleteBody()
				return null
			}
		}
	}

	async readLine(): Promise<string> {
		const line = await this.readLineOrEnd()
		if (line === null) throw incompleteBody()
		return line
	}

	async readExact(count: number): Promise<Uint8Array> {
		const out = new Uint8Array(count)
		let filled = 0
		while (filled < count) {
			if (this.buffer.length === 0 && !(await this.fill())) throw incompleteBody()
			const take = Math.min(count - filled, this.buffer.length)
			out.set(this.buffer.subarray(0, take), filled)
			filled += take
			this.buffer = this.buffer.subarray(take)
		}
		return out
	}
}

function indexOfCrlf(buffer: Uint8Array, from: number): number {
	for (let i = from; i < buffer.length - 1; i++) {
		if (buffer[i] === 13 && buffer[i + 1] === 10) return i
	}
	return -1
}

function parseChunkHeader(line: string, signed: boolean): { size: number, signature: string } {
	const pattern = signed ? /^([0-9a-fA-F]{1,8});chunk-signature=([0-9a-f]{64})$/ : /^([0-9a-fA-F]{1,8})$/
	const match = pattern.exec(line)
	if (!match) throw malformed()
	return { size: parseInt(match[1]!, 16), signature: match[2] ?? '' }
}

// Reads "name:value" lines until every announced trailer (and, when signed, the trailer signature) has arrived.
async function readTrailers(reader: ByteReader, announced: string[], signed: boolean): Promise<[string, string][]> {
	const missing = new Set(announced)
	if (signed) missing.add(TRAILER_SIGNATURE)

	const found: [string, string][] = []
	let blanks = 0
	while (missing.size > 0) {
		const line = await reader.readLine()
		if (line === '') {
			// Allow one blank line between the zero-size chunk and the trailers.
			if (++blanks > 1) throw incompleteBody()
			continue
		}
		const colon = line.indexOf(':')
		if (colon < 1) throw malformed()
		const name = line.slice(0, colon).trim().toLowerCase()
		found.push([name, line.slice(colon + 1).trim()])
		missing.delete(name)
	}

	// The trailers end with a blank line, which some clients leave out at the very end of the body.
	if (await reader.readLineOrEnd()) throw malformed()
	return found
}

// Yields the decoded bytes of each chunk, only after that chunk's signature has been checked.
// Trailing signatures, checksums, and the total size are checked after the last chunk, before the generator finishes,
// so a caller that stores the bytes can still discard them.
export async function* decodeChunked(
	body: ReadableStream<Uint8Array> | null,
	ctx: StreamingContext,
	options: { decodedLength: number, trailerNames: string[] },
): AsyncGenerator<Uint8Array> {
	if (!body) throw incompleteBody()

	const signed = ctx.mode !== 'unsigned-trailer'
	const hasTrailers = ctx.mode !== 'signed'
	const checksums = new Map<string, Checksum>()
	if (hasTrailers) {
		for (const name of options.trailerNames) {
			if (!name.startsWith(CHECKSUM_PREFIX)) continue
			const checksum = checksumFor(name.slice(CHECKSUM_PREFIX.length))
			if (!checksum) throw new S3Error('NotImplemented', 501, `The ${name} trailing checksum is not supported.`)
			checksums.set(name, checksum)
		}
	}

	const reader = new ByteReader(body)
	const scope = `${ctx.credential.date}/${ctx.credential.region}/${ctx.credential.service}/aws4_request`
	const sign = (stringToSign: string) => signatureFor(config.secretAccessKey, ctx.credential, stringToSign)
	let previous = ctx.seedSignature
	let total = 0

	for (;;) {
		const header = parseChunkHeader(await reader.readLine(), signed)
		if (header.size > config.maxFileBytes) {
			throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.')
		}
		const data = header.size ? await reader.readExact(header.size) : EMPTY

		if (signed) {
			const expected = sign(['AWS4-HMAC-SHA256-PAYLOAD', ctx.amzDate, scope, previous, EMPTY_SHA256, sha256Hex(data)].join('\n'))
			if (!safeEqual(expected, header.signature)) throw signatureMismatch()
			previous = header.signature
		}

		if (header.size === 0) break

		const end = await reader.readExact(2)
		if (end[0] !== 13 || end[1] !== 10) throw malformed()

		total += header.size
		if (total > options.decodedLength) throw lengthMismatch()
		for (const checksum of checksums.values()) checksum.update(data)
		yield data
	}

	if (hasTrailers) {
		const trailers = await readTrailers(reader, options.trailerNames, signed)
		if (signed) {
			const sent = trailers.find(([name]) => name === TRAILER_SIGNATURE)?.[1] ?? ''
			const canonical = trailers
				.filter(([name]) => name !== TRAILER_SIGNATURE)
				.map(([name, value]) => `${name}:${value}\n`)
				.join('')
			const expected = sign(['AWS4-HMAC-SHA256-TRAILER', ctx.amzDate, scope, previous, sha256Hex(canonical)].join('\n'))
			if (!safeEqual(expected, sent)) throw signatureMismatch()
		}
		for (const [name, checksum] of checksums) {
			const sent = trailers.find(([trailer]) => trailer === name)?.[1]
			if (sent !== checksum.digest()) {
				throw new S3Error('BadDigest', 400, `The ${name} you specified did not match the calculated checksum.`)
			}
		}
	} else if (await reader.readLineOrEnd()) {
		throw malformed()
	}

	if (total !== options.decodedLength) throw lengthMismatch()
}
