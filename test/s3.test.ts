import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { backup } from '../src/backup'
import { config, loadConfig } from '../src/config'
import { uploads } from '../src/db'
import { server } from '../src/index'
import { signatureFor } from '../src/s3/auth'
import { checksumFor } from '../src/s3/chunked'
import { expireUploads, MIN_PART_BYTES } from '../src/s3/multipart'
import { objectPath, writeObject } from '../src/storage'

// Remove the temp data folder after the run, even if tests failed.
// Set KEEP_TEST_DATA=1 to keep it for inspection.
afterAll(() => {
	const dir = Bun.env.TEST_DATA_DIR
	if (dir && !Bun.env.KEEP_TEST_DATA) rmSync(dir, { recursive: true, force: true })
})

type Creds = { accessKeyId: string, secretAccessKey: string }
type SignOptions = { creds?: Creds, amzDate?: string, signPath?: string, payloadHash?: string }

const newBucket = () => `t-${crypto.randomUUID().slice(0, 8)}`
const defaultCreds = (): Creds => ({ accessKeyId: Bun.env.ACCESS_KEY_ID ?? '', secretAccessKey: Bun.env.SECRET_ACCESS_KEY ?? '' })
const amzDateFor = (time: Date) => time.toISOString().replace(/[:-]|\.\d{3}/g, '')

// Signs like an SDK: host, x-amz-content-sha256, and x-amz-date are signed, with an unsigned payload.
function authHeaders(method: string, path: string, options: SignOptions): Record<string, string> {
	const url = new URL(path, server.url)
	const signPath = new URL(options.signPath ?? path, server.url).pathname
	const creds = options.creds ?? defaultCreds()
	const amzDate = options.amzDate ?? amzDateFor(new Date())
	const date = amzDate.slice(0, 8)
	const payloadHash = options.payloadHash ?? 'UNSIGNED-PAYLOAD'
	const signed = ['host', 'x-amz-content-sha256', 'x-amz-date']
	const values: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }

	const query = [...url.searchParams]
		.map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
		.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join('&')

	const canonical = [method, signPath, query, signed.map(h => `${h}:${values[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n')
	const scope = `${date}/us-east-1/s3/aws4_request`
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, new Bun.CryptoHasher('sha256').update(canonical).digest('hex')].join('\n')
	const signature = signatureFor(creds.secretAccessKey, { accessKeyId: creds.accessKeyId, date, region: 'us-east-1', service: 's3' }, stringToSign)

	return {
		authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
		'x-amz-date': amzDate,
		'x-amz-content-sha256': payloadHash,
	}
}

function rfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

// A body is signed with its real SHA-256, like an SDK does. Requests without a body sign UNSIGNED-PAYLOAD.
function request(method: string, path: string, init: RequestInit = {}, options: SignOptions = {}) {
	const headers = new Headers(init.headers)
	const body = init.body
	const payloadHash = options.payloadHash
		?? (typeof body === 'string' || body instanceof Uint8Array ? new Bun.CryptoHasher('sha256').update(body).digest('hex') : undefined)
	for (const [name, value] of Object.entries(authHeaders(method, path, { ...options, payloadHash }))) headers.set(name, value)
	return fetch(new URL(path, server.url), { ...init, method, headers })
}

// Builds a presigned URL the way an SDK does: the signature goes in the query string and the payload is UNSIGNED-PAYLOAD.
function presignedUrl(method: string, path: string, options: { expires?: number, amzDate?: string } = {}): URL {
	const url = new URL(path, server.url)
	const creds = defaultCreds()
	const amzDate = options.amzDate ?? amzDateFor(new Date())
	const scope = `${amzDate.slice(0, 8)}/us-east-1/s3/aws4_request`
	url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
	url.searchParams.set('X-Amz-Credential', `${creds.accessKeyId}/${scope}`)
	url.searchParams.set('X-Amz-Date', amzDate)
	url.searchParams.set('X-Amz-Expires', String(options.expires ?? 300))
	url.searchParams.set('X-Amz-SignedHeaders', 'host')

	const query = [...url.searchParams]
		.map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
		.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join('&')
	const canonical = [method, url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, new Bun.CryptoHasher('sha256').update(canonical).digest('hex')].join('\n')
	const signature = signatureFor(creds.secretAccessKey, { accessKeyId: creds.accessKeyId, date: amzDate.slice(0, 8), region: 'us-east-1', service: 's3' }, stringToSign)
	url.searchParams.set('X-Amz-Signature', signature)
	return url
}

function code(xml: string) {
	return xml.match(/<Code>(.*?)<\/Code>/)?.[1]
}

function keys(xml: string) {
	return [...xml.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1] ?? '')
}

describe('auth', () => {
	test('matches the AWS documented SigV4 example', () => {
		const stringToSign = [
			'AWS4-HMAC-SHA256',
			'20130524T000000Z',
			'20130524/us-east-1/s3/aws4_request',
			'7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
		].join('\n')
		const signature = signatureFor(
			'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			{ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', date: '20130524', region: 'us-east-1', service: 's3' },
			stringToSign,
		)
		expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
	})

	test('a request with no authorization header is denied', async () => {
		const res = await fetch(new URL('/', server.url))
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('AccessDenied')
	})

	test('a wrong secret returns SignatureDoesNotMatch', async () => {
		const res = await request('GET', '/', {}, { creds: { ...defaultCreds(), secretAccessKey: 'wrong' } })
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('SignatureDoesNotMatch')
	})

	test('an unknown access key ID returns InvalidAccessKeyId', async () => {
		const res = await request('GET', '/', {}, { creds: { ...defaultCreds(), accessKeyId: 'NOPE' } })
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('InvalidAccessKeyId')
	})

	test('a timestamp more than 15 minutes old returns RequestTimeTooSkewed', async () => {
		const old = amzDateFor(new Date(Date.now() - 16 * 60 * 1000))
		const res = await request('GET', '/', {}, { amzDate: old })
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('RequestTimeTooSkewed')
	})

	test('a signature made for one path does not work for another', async () => {
		const name = newBucket()
		const res = await request('PUT', `/${name}`, {}, { signPath: `/${newBucket()}` })
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('SignatureDoesNotMatch')
	})
})

describe('path defaults', () => {
	test('everything except backups defaults to a folder under DATA_DIR', () => {
		const c = loadConfig({ DATA_DIR: '/srv/store', ACCESS_KEY_ID: 'a', SECRET_ACCESS_KEY: 'b' })
		expect(c.sqlitePath).toBe('/srv/store/storage.db')
		expect(c.logDir).toBe('/srv/store/logs')
		expect(c.bucketsDir).toBe('/srv/store/buckets')
		expect(c.backupDir).toBe('./backups')
	})

	test('BACKUP_DIR overrides its default', () => {
		const c = loadConfig({ DATA_DIR: '/srv/store', BACKUP_DIR: '/mnt/b', ACCESS_KEY_ID: 'a', SECRET_ACCESS_KEY: 'b' })
		expect(c.backupDir).toBe('/mnt/b')
	})
})

describe('health', () => {
	test('GET /health returns 200 without a signature', async () => {
		const res = await fetch(new URL('/health', server.url))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ status: 'ok' })
	})
})

describe('presigned URLs', () => {
	test('a presigned GET works without an authorization header', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'shared' })

		const res = await fetch(presignedUrl('GET', `/${name}/a.txt`))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('shared')
	})

	test('an expired presigned URL is denied', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const twoHoursAgo = amzDateFor(new Date(Date.now() - 2 * 60 * 60 * 1000))

		const res = await fetch(presignedUrl('GET', `/${name}`, { expires: 60, amzDate: twoHoursAgo }))
		const body = await res.text()
		expect(res.status).toBe(403)
		expect(code(body)).toBe('AccessDenied')
		expect(body).toContain('Request has expired')
	})

	test('a presigned URL for GET cannot be used with PUT', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)

		const res = await fetch(presignedUrl('GET', `/${name}/a.txt`), { method: 'PUT', body: 'x' })
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('SignatureDoesNotMatch')
	})

	test('a changed presigned URL is denied', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const url = presignedUrl('GET', `/${name}/a.txt`)
		url.searchParams.set('X-Amz-Expires', '600')

		const res = await fetch(url)
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('SignatureDoesNotMatch')
	})
})

describe('backup', () => {
	test('the default backup folder is outside DATA_DIR', () => {
		const backups = resolve(config.backupDir)
		expect(backups.startsWith(resolve(config.dataDir) + sep)).toBe(false)
	})

	test('refuses a backup folder inside DATA_DIR and writes nothing', () => {
		const inside = join(config.dataDir, 'nested-backup')
		expect(() => backup(inside)).toThrow('inside DATA_DIR')
		expect(existsSync(inside)).toBe(false)
	})

	test('a backup has the object files and a readable database copy', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'kept' })

		const dest = mkdtempSync(join(tmpdir(), 's3-backup-'))
		try {
			backup(join(dest, 'copy'))

			expect(readFileSync(join(dest, 'copy', 'buckets', name, 'a.txt'), 'utf8')).toBe('kept')
			const copy = new Database(join(dest, 'copy', basename(config.sqlitePath)), { readonly: true })
			expect(copy.query('SELECT key FROM objects WHERE bucket = ?').all(name)).toEqual([{ key: 'a.txt' }])
			copy.close()
		} finally {
			rmSync(dest, { recursive: true, force: true })
		}
	})
})

describe('logging', () => {
	test('each request logs method, path, status, and time, without the query string', async () => {
		const lines: string[] = []
		const spy = spyOn(console, 'log').mockImplementation((line: string) => lines.push(String(line)))
		try {
			await fetch(new URL('/health?secret=1', server.url))
		} finally {
			spy.mockRestore()
		}
		expect(lines).toContainEqual(expect.stringMatching(/^GET \/health 200 \d+(\.\d+)?ms$/))
	})

	test('each request line is also appended to DATA_DIR/logs/server.log', async () => {
		await fetch(new URL('/health?marker=file', server.url))
		const written = readFileSync(join(config.logDir, 'server.log'), 'utf8')
		expect(written).toMatch(/GET \/health 200 \d+(\.\d+)?ms\n$/)
	})

	test('a failed log file write does not fail the request', async () => {
		const logPath = join(config.logDir, 'server.log')
		const saved = join(config.logDir, 'server.log.saved')
		renameSync(logPath, saved)
		mkdirSync(logPath)
		const spy = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const res = await fetch(new URL('/health', server.url))
			expect(res.status).toBe(200)
		} finally {
			spy.mockRestore()
			rmSync(logPath, { recursive: true, force: true })
			renameSync(saved, logPath)
		}
	})
})

describe('buckets', () => {
	test('create, head, and list', async () => {
		const name = newBucket()
		const created = await request('PUT', `/${name}`)
		expect(created.status).toBe(200)
		expect(created.headers.get('location')).toBe(`/${name}`)

		expect((await request('HEAD', `/${name}`)).status).toBe(200)

		const list = await request('GET', '/')
		expect(list.headers.get('content-type')).toBe('application/xml')
		expect(await list.text()).toContain(`<Name>${name}</Name>`)
	})

	test('bucket requests with a trailing slash reach the bucket handlers', async () => {
		const name = newBucket()
		expect((await request('PUT', `/${name}/`)).status).toBe(200)
		expect((await request('HEAD', `/${name}/`)).status).toBe(200)

		const list = await request('GET', `/${name}/`)
		expect(list.status).toBe(200)
		expect(await list.text()).toContain('<ListBucketResult')

		expect((await request('DELETE', `/${name}/`)).status).toBe(204)
		expect((await request('HEAD', `/${name}`)).status).toBe(404)
	})

	test('creating an existing bucket returns BucketAlreadyExists', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const again = await request('PUT', `/${name}`)
		expect(again.status).toBe(409)
		expect(code(await again.text())).toBe('BucketAlreadyExists')
	})

	test('invalid bucket names are rejected', async () => {
		const res = await request('PUT', '/Bad_Name')
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('InvalidBucketName')
	})

	test('head and delete a missing bucket', async () => {
		const name = newBucket()
		expect((await request('HEAD', `/${name}`)).status).toBe(404)

		const del = await request('DELETE', `/${name}`)
		expect(del.status).toBe(404)
		expect(code(await del.text())).toBe('NoSuchBucket')
	})

	test('a bucket with objects cannot be deleted', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'x' })

		const blocked = await request('DELETE', `/${name}`)
		expect(blocked.status).toBe(409)
		expect(code(await blocked.text())).toBe('BucketNotEmpty')

		await request('DELETE', `/${name}/a.txt`)
		expect((await request('DELETE', `/${name}`)).status).toBe(204)
	})
})

describe('objects', () => {
	test('put, get, and head return the same bytes and metadata', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const md5 = new Bun.CryptoHasher('md5').update('hello').digest('hex')

		const put = await request('PUT', `/${name}/2026/a.txt`, {
			body: 'hello',
			headers: { 'Content-Type': 'text/plain' },
		})
		expect(put.status).toBe(200)
		expect(put.headers.get('etag')).toBe(`"${md5}"`)

		const get = await request('GET', `/${name}/2026/a.txt`)
		expect(get.status).toBe(200)
		expect(await get.text()).toBe('hello')
		expect(get.headers.get('content-type')).toBe('text/plain')
		expect(get.headers.get('etag')).toBe(`"${md5}"`)

		const head = await request('HEAD', `/${name}/2026/a.txt`)
		expect(head.status).toBe(200)
		expect(head.headers.get('content-length')).toBe('5')
	})

	test('a body that matches the signed x-amz-content-sha256 is stored', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const sha256 = new Bun.CryptoHasher('sha256').update('hello').digest('hex')

		const put = await request('PUT', `/${name}/signed.txt`, { body: 'hello' }, { payloadHash: sha256 })
		expect(put.status).toBe(200)
		expect(await (await request('GET', `/${name}/signed.txt`)).text()).toBe('hello')
	})

	test('a body that does not match the signed x-amz-content-sha256 is rejected and not stored', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const claimed = new Bun.CryptoHasher('sha256').update('the bytes the client signed').digest('hex')

		const put = await request('PUT', `/${name}/tampered.txt`, { body: 'swapped bytes' }, { payloadHash: claimed })
		expect(put.status).toBe(400)
		expect(await put.text()).toContain('XAmzContentSHA256Mismatch')
		expect((await request('GET', `/${name}/tampered.txt`)).status).toBe(404)
	})

	test('a header-signed upload that signs UNSIGNED-PAYLOAD is rejected and not stored', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)

		const put = await request('PUT', `/${name}/unsigned.txt`, { body: 'x' }, { payloadHash: 'UNSIGNED-PAYLOAD' })
		expect(put.status).toBe(400)
		expect(code(await put.text())).toBe('InvalidRequest')
		expect((await request('GET', `/${name}/unsigned.txt`)).status).toBe(404)
	})

	test('a presigned PUT is still accepted, even with an UNSIGNED-PAYLOAD header', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)

		const put = await fetch(presignedUrl('PUT', `/${name}/link.txt`), {
			method: 'PUT',
			body: 'via link',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		})
		expect(put.status).toBe(200)
		expect(await (await request('GET', `/${name}/link.txt`)).text()).toBe('via link')
	})

	test('get a missing key returns NoSuchKey', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)

		const res = await request('GET', `/${name}/nope.txt`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchKey')
	})

	test('put to a missing bucket returns NoSuchBucket', async () => {
		const res = await request('PUT', `/${newBucket()}/a.txt`, { body: 'x' })
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucket')
	})

	test('delete removes the object, and deleting a missing key still returns 204', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'x' })

		expect((await request('DELETE', `/${name}/a.txt`)).status).toBe(204)
		expect((await request('GET', `/${name}/a.txt`)).status).toBe(404)
		expect((await request('DELETE', `/${name}/a.txt`)).status).toBe(204)
	})

	test('uploads over MAX_FILE_BYTES are rejected', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)

		const res = await request('PUT', `/${name}/big.bin`, {
			body: new Uint8Array(config.maxFileBytes + 1),
		})
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('EntityTooLarge')
	})

	test('a failed overwrite keeps the old object', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'v1' })

		const broken = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('partial'))
				controller.error(new Error('upload broke'))
			},
		})
		await expect(writeObject(objectPath(config.bucketsDir, name, 'a.txt'), broken)).rejects.toThrow('upload broke')

		const get = await request('GET', `/${name}/a.txt`)
		expect(await get.text()).toBe('v1')
	})

	test('object files live under DATA_DIR/buckets/<bucket>/', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'x' })

		expect(readFileSync(join(config.bucketsDir, name, 'a.txt'), 'utf8')).toBe('x')
	})

	test('a bucket named like a server file does not overwrite it', async () => {
		await request('PUT', '/logs')
		await request('PUT', '/logs/server.log', { body: 'object bytes' })

		const log = readFileSync(join(config.logDir, 'server.log'), 'utf8')
		expect(log.startsWith('object bytes')).toBe(false)
		expect(log).toContain('PUT /logs/server.log')
	})

	test('keys that escape the bucket folder are rejected', () => {
		expect(() => objectPath('/data', 'photos', '../secret')).toThrow('Invalid Argument')
	})
})

describe('aws-chunked uploads', () => {
	type Mode = 'signed' | 'signed-trailer' | 'unsigned-trailer'
	const PAYLOAD_HASH: Record<Mode, string> = {
		'signed': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
		'signed-trailer': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
		'unsigned-trailer': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
	}
	type Upload = {
		mode: Mode
		chunks: string[]
		// Trailing checksum to send. A value overrides the real one, to test a mismatch.
		checksum?: { algorithm: 'crc32' | 'sha256', value?: string }
		// null leaves the x-amz-decoded-content-length header out.
		decodedLength?: number | null
		// Change the first chunk's bytes after signing it.
		tamper?: boolean
		// Cut the body short, in the middle of the last chunk header.
		truncate?: boolean
	}

	const hash = (algorithm: string, data: string, encoding: 'hex' | 'base64' = 'hex') =>
		new Bun.CryptoHasher(algorithm as 'md5' | 'sha256').update(data).digest(encoding)

	function realChecksum(algorithm: 'crc32' | 'sha256', data: string): string {
		if (algorithm === 'sha256') return hash('sha256', data, 'base64')
		const out = Buffer.alloc(4)
		out.writeUInt32BE(Bun.hash.crc32(data))
		return out.toString('base64')
	}

	// Signs and sends an aws-chunked PUT the way an SDK does: the request signature starts the chunk signature chain.
	async function putChunked(path: string, upload: Upload): Promise<Response> {
		const amzDate = amzDateFor(new Date())
		const headers = authHeaders('PUT', path, { payloadHash: PAYLOAD_HASH[upload.mode], amzDate })
		const seed = /Signature=([0-9a-f]{64})/.exec(headers.authorization!)![1]!
		const creds = defaultCreds()
		const date = amzDate.slice(0, 8)
		const scope = `${date}/us-east-1/s3/aws4_request`
		const sign = (stringToSign: string) =>
			signatureFor(creds.secretAccessKey, { accessKeyId: creds.accessKeyId, date, region: 'us-east-1', service: 's3' }, stringToSign)
		const signed = upload.mode !== 'unsigned-trailer'
		const data = upload.chunks.join('')

		let previous = seed
		let body = ''
		for (const chunk of [...upload.chunks, '']) {
			const size = chunk.length.toString(16)
			if (signed) {
				previous = sign(['AWS4-HMAC-SHA256-PAYLOAD', amzDate, scope, previous, hash('sha256', ''), hash('sha256', chunk)].join('\n'))
				body += `${size};chunk-signature=${previous}\r\n`
			} else {
				body += `${size}\r\n`
			}
			if (chunk) body += `${chunk}\r\n`
		}

		let trailerName = ''
		if (upload.mode === 'signed') {
			body += '\r\n'
		} else {
			let canonical = ''
			if (upload.checksum) {
				trailerName = `x-amz-checksum-${upload.checksum.algorithm}`
				const value = upload.checksum.value ?? realChecksum(upload.checksum.algorithm, data)
				canonical = `${trailerName}:${value}\n`
				body += `${trailerName}:${value}\r\n`
			}
			if (signed) body += `x-amz-trailer-signature:${sign(['AWS4-HMAC-SHA256-TRAILER', amzDate, scope, previous, hash('sha256', canonical)].join('\n'))}\r\n`
			body += '\r\n'
		}

		if (upload.tamper) body = body.replace(upload.chunks[0]!, upload.chunks[0]!.toUpperCase())
		if (upload.truncate) body = body.slice(0, body.indexOf('\r\n0;') + 12)

		const decoded = upload.decodedLength === undefined ? String(data.length) : upload.decodedLength === null ? undefined : String(upload.decodedLength)
		return fetch(new URL(path, server.url), {
			method: 'PUT',
			headers: {
				...headers,
				'content-encoding': 'aws-chunked',
				...(decoded === undefined ? {} : { 'x-amz-decoded-content-length': decoded }),
				...(trailerName ? { 'x-amz-trailer': trailerName } : {}),
			},
			body,
		})
	}

	async function newUploadBucket(): Promise<string> {
		const name = newBucket()
		await request('PUT', `/${name}`)
		return name
	}

	async function expectNotStored(bucket: string, key: string) {
		expect((await request('GET', `/${bucket}/${key}`)).status).toBe(404)
	}

	test('signed chunks are decoded and stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/a.txt`, { mode: 'signed', chunks: ['hello ', 'world', '!'] })
		expect(put.status).toBe(200)
		expect(put.headers.get('etag')).toBe(`"${hash('md5', 'hello world!')}"`)
		expect(await (await request('GET', `/${bucket}/a.txt`)).text()).toBe('hello world!')
	})

	test('chunks larger than a network read are decoded', async () => {
		const bucket = await newUploadBucket()
		const chunks = ['a'.repeat(70_000), 'b'.repeat(70_000), 'c']
		const put = await putChunked(`/${bucket}/big.bin`, { mode: 'signed', chunks })
		expect(put.status).toBe(200)
		expect(await (await request('GET', `/${bucket}/big.bin`)).text()).toBe(chunks.join(''))
	})

	test('a chunk changed after signing is rejected and not stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/t.txt`, { mode: 'signed', chunks: ['hello ', 'world'], tamper: true })
		expect(put.status).toBe(403)
		expect(code(await put.text())).toBe('SignatureDoesNotMatch')
		await expectNotStored(bucket, 't.txt')
	})

	test('a truncated body is rejected and not stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/cut.txt`, { mode: 'signed', chunks: ['hello ', 'world'], truncate: true })
		expect(put.status).toBe(400)
		expect(code(await put.text())).toBe('IncompleteBody')
		await expectNotStored(bucket, 'cut.txt')
	})

	test('x-amz-decoded-content-length must match the decoded bytes', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/len.txt`, { mode: 'signed', chunks: ['hello world'], decodedLength: 3 })
		expect(put.status).toBe(400)
		expect(code(await put.text())).toBe('IncompleteBody')
		await expectNotStored(bucket, 'len.txt')
	})

	test('a missing x-amz-decoded-content-length returns MissingContentLength', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/none.txt`, { mode: 'signed', chunks: ['x'], decodedLength: null })
		expect(put.status).toBe(411)
		expect(code(await put.text())).toBe('MissingContentLength')
	})

	test('the size limit applies to the decoded length', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/huge.bin`, { mode: 'signed', chunks: ['x'], decodedLength: config.maxFileBytes + 1 })
		expect(put.status).toBe(400)
		expect(code(await put.text())).toBe('EntityTooLarge')
	})

	test('signed chunks with a signed crc32 trailer are stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/c.txt`, { mode: 'signed-trailer', chunks: ['hello ', 'world'], checksum: { algorithm: 'crc32' } })
		expect(put.status).toBe(200)
		expect(await (await request('GET', `/${bucket}/c.txt`)).text()).toBe('hello world')
	})

	test('signed chunks with a signed sha256 trailer are stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/s.txt`, { mode: 'signed-trailer', chunks: ['hello ', 'world'], checksum: { algorithm: 'sha256' } })
		expect(put.status).toBe(200)
	})

	test('signed chunks without a checksum trailer are stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/n.txt`, { mode: 'signed-trailer', chunks: ['hello'] })
		expect(put.status).toBe(200)
	})

	test('a wrong checksum in a signed trailer returns BadDigest and nothing is stored', async () => {
		const bucket = await newUploadBucket()
		const wrong = realChecksum('crc32', 'something else')
		const put = await putChunked(`/${bucket}/bad.txt`, { mode: 'signed-trailer', chunks: ['hello world'], checksum: { algorithm: 'crc32', value: wrong } })
		// The trailer signature covers the wrong value, so the signature is valid and the checksum is what fails.
		expect(put.status).toBe(400)
		expect(code(await put.text())).toBe('BadDigest')
		await expectNotStored(bucket, 'bad.txt')
	})

	test('unsigned chunks with a crc32 trailer are stored', async () => {
		const bucket = await newUploadBucket()
		const put = await putChunked(`/${bucket}/u.txt`, { mode: 'unsigned-trailer', chunks: ['hello ', 'world'], checksum: { algorithm: 'crc32' } })
		expect(put.status).toBe(200)
		expect(await (await request('GET', `/${bucket}/u.txt`)).text()).toBe('hello world')
	})

	test('a wrong checksum in an unsigned trailer returns BadDigest and nothing is stored', async () => {
		const bucket = await newUploadBucket()
		const wrong = realChecksum('crc32', 'something else')
		const put = await putChunked(`/${bucket}/ubad.txt`, { mode: 'unsigned-trailer', chunks: ['hello world'], checksum: { algorithm: 'crc32', value: wrong } })
		expect(put.status).toBe(400)
		expect(code(await put.text())).toBe('BadDigest')
		await expectNotStored(bucket, 'ubad.txt')
	})

	test('other streaming payload types return NotImplemented', async () => {
		const bucket = await newUploadBucket()
		const put = await request('PUT', `/${bucket}/x.txt`, { body: 'x' }, { payloadHash: 'STREAMING-AWS4-ECDSA-P256-SHA256-PAYLOAD' })
		expect(put.status).toBe(501)
	})

	test('crc32 and crc32c match their standard test values', () => {
		for (const [algorithm, hex] of [['crc32', 'cbf43926'], ['crc32c', 'e3069283']] as const) {
			const checksum = checksumFor(algorithm)!
			checksum.update(new TextEncoder().encode('123456789'))
			expect(checksum.digest()).toBe(Buffer.from(hex, 'hex').toString('base64'))
		}
	})
})

describe('multipart upload', () => {
	const md5 = (data: string) => new Bun.CryptoHasher('md5').update(data).digest('hex')
	// Every part except the last must be at least 5 MiB, so tests that join several parts use one this size first.
	const big = 'a'.repeat(MIN_PART_BYTES)

	// S3's multipart ETag: the MD5 of the parts' binary MD5s, then "-" and the part count.
	function multipartEtag(...parts: string[]): string {
		const hasher = new Bun.CryptoHasher('md5')
		for (const part of parts) hasher.update(Buffer.from(md5(part), 'hex'))
		return `${hasher.digest('hex')}-${parts.length}`
	}

	const completeXml = (parts: [number, string][]) =>
		`<CompleteMultipartUpload>${parts.map(([n, etag]) => `<Part><PartNumber>${n}</PartNumber><ETag>"${etag}"</ETag></Part>`).join('')}</CompleteMultipartUpload>`

	async function newBucketForUpload(): Promise<string> {
		const name = newBucket()
		await request('PUT', `/${name}`)
		return name
	}

	async function start(bucket: string, key: string, headers: Record<string, string> = {}): Promise<string> {
		const res = await request('POST', `/${bucket}/${key}?uploads`, { headers })
		expect(res.status).toBe(200)
		return /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())![1]!
	}

	const putPart = (bucket: string, key: string, uploadId: string, number: number | string, body: string) =>
		request('PUT', `/${bucket}/${key}?partNumber=${number}&uploadId=${uploadId}`, { body })

	const complete = (bucket: string, key: string, uploadId: string, parts: [number, string][]) =>
		request('POST', `/${bucket}/${key}?uploadId=${uploadId}`, { body: completeXml(parts) })

	test('create, upload parts, complete: the object is the parts joined, with the multipart ETag', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'dir/big.txt', { 'Content-Type': 'text/plain' })

		const first = await putPart(bucket, 'dir/big.txt', uploadId, 1, big)
		const second = await putPart(bucket, 'dir/big.txt', uploadId, 2, 'world')
		expect(first.status).toBe(200)
		expect(first.headers.get('etag')).toBe(`"${md5(big)}"`)

		const done = await complete(bucket, 'dir/big.txt', uploadId, [[1, md5(big)], [2, md5('world')]])
		expect(done.status).toBe(200)
		const etag = multipartEtag(big, 'world')
		expect(await done.text()).toContain(`<ETag>"${etag}"</ETag>`)
		expect(second.status).toBe(200)

		const get = await request('GET', `/${bucket}/dir/big.txt`)
		expect(await get.text()).toBe(`${big}world`)
		expect(get.headers.get('etag')).toBe(`"${etag}"`)
		expect(get.headers.get('content-type')).toBe('text/plain')
		expect(existsSync(join(config.uploadsDir, uploadId))).toBe(false)
	})

	test('parts can be uploaded out of order and any part can be left out of the list', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'o.txt')
		await putPart(bucket, 'o.txt', uploadId, 3, 'C')
		await putPart(bucket, 'o.txt', uploadId, 1, big)
		await putPart(bucket, 'o.txt', uploadId, 2, 'unused')

		const done = await complete(bucket, 'o.txt', uploadId, [[1, md5(big)], [3, md5('C')]])
		expect(done.status).toBe(200)
		expect(await (await request('GET', `/${bucket}/o.txt`)).text()).toBe(`${big}C`)
	})

	test('a part under 5 MiB is only allowed as the last part', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'small.txt')
		await putPart(bucket, 'small.txt', uploadId, 1, 'tiny')
		await putPart(bucket, 'small.txt', uploadId, 2, 'also tiny')

		const done = await complete(bucket, 'small.txt', uploadId, [[1, md5('tiny')], [2, md5('also tiny')]])
		expect(done.status).toBe(400)
		expect(code(await done.text())).toBe('EntityTooSmall')
		expect((await request('GET', `/${bucket}/small.txt`)).status).toBe(404)

		// The same upload completes when the small part is the last one, or the only one.
		expect((await complete(bucket, 'small.txt', uploadId, [[2, md5('also tiny')]])).status).toBe(200)
		expect(await (await request('GET', `/${bucket}/small.txt`)).text()).toBe('also tiny')
	})

	test('uploading a part number again replaces the earlier part', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'r.txt')
		await putPart(bucket, 'r.txt', uploadId, 1, 'old')
		await putPart(bucket, 'r.txt', uploadId, 1, 'new!')

		const stale = await complete(bucket, 'r.txt', uploadId, [[1, md5('old')]])
		expect(stale.status).toBe(400)
		expect(code(await stale.text())).toBe('InvalidPart')

		expect((await complete(bucket, 'r.txt', uploadId, [[1, md5('new!')]])).status).toBe(200)
		expect(await (await request('GET', `/${bucket}/r.txt`)).text()).toBe('new!')
	})

	test('a parts list out of order returns InvalidPartOrder', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'order.txt')
		await putPart(bucket, 'order.txt', uploadId, 1, 'a')
		await putPart(bucket, 'order.txt', uploadId, 2, 'b')

		const done = await complete(bucket, 'order.txt', uploadId, [[2, md5('b')], [1, md5('a')]])
		expect(done.status).toBe(400)
		expect(code(await done.text())).toBe('InvalidPartOrder')
	})

	test('a wrong ETag or a part that was never uploaded returns InvalidPart and stores nothing', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'bad.txt')
		await putPart(bucket, 'bad.txt', uploadId, 1, 'a')

		const wrong = await complete(bucket, 'bad.txt', uploadId, [[1, md5('different')]])
		expect(wrong.status).toBe(400)
		expect(code(await wrong.text())).toBe('InvalidPart')

		const missing = await complete(bucket, 'bad.txt', uploadId, [[1, md5('a')], [2, md5('b')]])
		expect(code(await missing.text())).toBe('InvalidPart')
		expect((await request('GET', `/${bucket}/bad.txt`)).status).toBe(404)
	})

	test('an empty or malformed parts list returns MalformedXML', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'x.txt')
		const res = await request('POST', `/${bucket}/x.txt?uploadId=${uploadId}`, { body: '<CompleteMultipartUpload></CompleteMultipartUpload>' })
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('MalformedXML')
	})

	test('completing over the size limit returns EntityTooLarge and keeps the old object', async () => {
		const bucket = await newBucketForUpload()
		await request('PUT', `/${bucket}/limit.bin`, { body: 'old object' })
		const uploadId = await start(bucket, 'limit.bin')
		// Each part is within the limit and at least 5 MiB, but together they are over it.
		const half = 'x'.repeat(Math.max(MIN_PART_BYTES, Math.ceil(config.maxFileBytes * 0.6)))
		await putPart(bucket, 'limit.bin', uploadId, 1, half)
		await putPart(bucket, 'limit.bin', uploadId, 2, half)

		const done = await complete(bucket, 'limit.bin', uploadId, [[1, md5(half)], [2, md5(half)]])
		expect(done.status).toBe(400)
		expect(code(await done.text())).toBe('EntityTooLarge')
		expect(await (await request('GET', `/${bucket}/limit.bin`)).text()).toBe('old object')
	})

	test('abort removes the parts, and the upload is gone afterwards', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'abort.txt')
		await putPart(bucket, 'abort.txt', uploadId, 1, 'a')
		expect(existsSync(join(config.uploadsDir, uploadId))).toBe(true)

		const abort = await request('DELETE', `/${bucket}/abort.txt?uploadId=${uploadId}`)
		expect(abort.status).toBe(204)
		expect(existsSync(join(config.uploadsDir, uploadId))).toBe(false)

		const late = await putPart(bucket, 'abort.txt', uploadId, 2, 'b')
		expect(late.status).toBe(404)
		expect(code(await late.text())).toBe('NoSuchUpload')
		expect((await request('DELETE', `/${bucket}/abort.txt?uploadId=${uploadId}`)).status).toBe(404)
	})

	test('an unknown upload ID, or the wrong key, returns NoSuchUpload', async () => {
		const bucket = await newBucketForUpload()
		const unknown = await putPart(bucket, 'a.txt', 'doesnotexist', 1, 'x')
		expect(unknown.status).toBe(404)
		expect(code(await unknown.text())).toBe('NoSuchUpload')

		const uploadId = await start(bucket, 'a.txt')
		const otherKey = await putPart(bucket, 'b.txt', uploadId, 1, 'x')
		expect(otherKey.status).toBe(404)
		expect(code(await otherKey.text())).toBe('NoSuchUpload')
	})

	test('part numbers must be between 1 and 10000', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'n.txt')
		for (const number of ['0', '10001', 'abc', '-1']) {
			const res = await putPart(bucket, 'n.txt', uploadId, number, 'x')
			expect(res.status).toBe(400)
			expect(code(await res.text())).toBe('InvalidArgument')
		}
	})

	test('starting an upload in a missing bucket returns NoSuchBucket', async () => {
		const res = await request('POST', `/${newBucket()}/k.txt?uploads`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucket')
	})

	test('a part must be covered by the signature, like any upload', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'sig.txt')
		const url = `/${bucket}/sig.txt?partNumber=1&uploadId=${uploadId}`

		const unsigned = await request('PUT', url, { body: 'x' }, { payloadHash: 'UNSIGNED-PAYLOAD' })
		expect(unsigned.status).toBe(400)
		expect(code(await unsigned.text())).toBe('InvalidRequest')

		const claimed = new Bun.CryptoHasher('sha256').update('the bytes the client signed').digest('hex')
		const swapped = await request('PUT', url, { body: 'swapped bytes' }, { payloadHash: claimed })
		expect(swapped.status).toBe(400)
		expect(code(await swapped.text())).toBe('XAmzContentSHA256Mismatch')

		const done = await complete(bucket, 'sig.txt', uploadId, [[1, md5('swapped bytes')]])
		expect(code(await done.text())).toBe('InvalidPart')
	})

	test('the parts list must be signed too', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'list.txt')
		await putPart(bucket, 'list.txt', uploadId, 1, 'a')
		const res = await request('POST', `/${bucket}/list.txt?uploadId=${uploadId}`, { body: completeXml([[1, md5('a')]]) }, { payloadHash: 'UNSIGNED-PAYLOAD' })
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('InvalidRequest')
	})

	const copyPart = (bucket: string, key: string, uploadId: string, number: number, source: string, range?: string) =>
		request('PUT', `/${bucket}/${key}?partNumber=${number}&uploadId=${uploadId}`, {
			headers: { 'x-amz-copy-source': source, ...(range ? { 'x-amz-copy-source-range': range } : {}) },
		})

	test('UploadPartCopy copies a whole object or a byte range into a part', async () => {
		const bucket = await newBucketForUpload()
		await request('PUT', `/${bucket}/src.bin`, { body: `${big}tail` })
		const uploadId = await start(bucket, 'dest.bin')

		const first = await copyPart(bucket, 'dest.bin', uploadId, 1, `/${bucket}/src.bin`, `bytes=0-${MIN_PART_BYTES - 1}`)
		expect(first.status).toBe(200)
		expect(await first.text()).toContain(`<ETag>"${md5(big)}"</ETag>`)
		const second = await copyPart(bucket, 'dest.bin', uploadId, 2, `${bucket}/src.bin`, `bytes=${MIN_PART_BYTES}-${MIN_PART_BYTES + 3}`)
		expect(second.status).toBe(200)

		const done = await complete(bucket, 'dest.bin', uploadId, [[1, md5(big)], [2, md5('tail')]])
		expect(done.status).toBe(200)
		expect(await (await request('GET', `/${bucket}/dest.bin`)).text()).toBe(`${big}tail`)

		const whole = await start(bucket, 'whole.bin')
		const wholeCopy = await copyPart(bucket, 'whole.bin', whole, 1, `/${bucket}/src.bin`)
		expect(await wholeCopy.text()).toContain(`<ETag>"${md5(`${big}tail`)}"</ETag>`)
	})

	test('UploadPartCopy rejects a missing source and a bad range', async () => {
		const bucket = await newBucketForUpload()
		await request('PUT', `/${bucket}/small.bin`, { body: '0123456789' })
		const uploadId = await start(bucket, 'dest.bin')

		const missing = await copyPart(bucket, 'dest.bin', uploadId, 1, `/${bucket}/nope.bin`)
		expect(missing.status).toBe(404)
		expect(code(await missing.text())).toBe('NoSuchKey')

		const beyond = await copyPart(bucket, 'dest.bin', uploadId, 1, `/${bucket}/small.bin`, 'bytes=5-10')
		expect(beyond.status).toBe(400)
		expect(code(await beyond.text())).toBe('InvalidRequest')

		const malformed = await copyPart(bucket, 'dest.bin', uploadId, 1, `/${bucket}/small.bin`, 'bytes=abc')
		expect(code(await malformed.text())).toBe('InvalidArgument')
	})

	const partNumbers = (xml: string) => [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]))

	test('ListParts lists the uploaded parts a page at a time', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'parts.txt')
		await putPart(bucket, 'parts.txt', uploadId, 3, 'ccc')
		await putPart(bucket, 'parts.txt', uploadId, 1, 'a')
		await putPart(bucket, 'parts.txt', uploadId, 2, 'bb')

		const all = await (await request('GET', `/${bucket}/parts.txt?uploadId=${uploadId}`)).text()
		expect(partNumbers(all)).toEqual([1, 2, 3])
		expect(all).toContain(`<ETag>"${md5('bb')}"</ETag>`)
		expect(all).toContain('<Size>2</Size>')
		expect(all).toContain('<IsTruncated>false</IsTruncated>')

		const page = await (await request('GET', `/${bucket}/parts.txt?uploadId=${uploadId}&max-parts=2`)).text()
		expect(partNumbers(page)).toEqual([1, 2])
		expect(page).toContain('<IsTruncated>true</IsTruncated>')
		expect(page).toContain('<NextPartNumberMarker>2</NextPartNumberMarker>')

		const rest = await (await request('GET', `/${bucket}/parts.txt?uploadId=${uploadId}&part-number-marker=2`)).text()
		expect(partNumbers(rest)).toEqual([3])
		expect(rest).toContain('<IsTruncated>false</IsTruncated>')
	})

	test('ListParts on an unknown upload returns NoSuchUpload', async () => {
		const bucket = await newBucketForUpload()
		const res = await request('GET', `/${bucket}/x.txt?uploadId=doesnotexist`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchUpload')
	})

	const uploadKeys = (xml: string) => [...xml.matchAll(/<Upload>[\s\S]*?<Key>([^<]*)<\/Key>/g)].map(match => match[1])
	const uploadIds = (xml: string) => [...xml.matchAll(/<UploadId>([^<]+)<\/UploadId>/g)].map(match => match[1])

	test('ListMultipartUploads lists uploads in progress, with prefix and delimiter', async () => {
		const bucket = await newBucketForUpload()
		await start(bucket, 'a/1.txt')
		await start(bucket, 'a/2.txt')
		await start(bucket, 'b.txt')
		const finished = await start(bucket, 'done.txt')
		await putPart(bucket, 'done.txt', finished, 1, 'x')
		await complete(bucket, 'done.txt', finished, [[1, md5('x')]])
		const stopped = await start(bucket, 'stopped.txt')
		await request('DELETE', `/${bucket}/stopped.txt?uploadId=${stopped}`)

		const all = await (await request('GET', `/${bucket}?uploads`)).text()
		expect(uploadKeys(all)).toEqual(['a/1.txt', 'a/2.txt', 'b.txt'])
		expect(all).toContain('<IsTruncated>false</IsTruncated>')

		const slash = await (await request('GET', `/${bucket}/?uploads`)).text()
		expect(uploadKeys(slash)).toEqual(['a/1.txt', 'a/2.txt', 'b.txt'])

		const prefixed = await (await request('GET', `/${bucket}?uploads&prefix=a/`)).text()
		expect(uploadKeys(prefixed)).toEqual(['a/1.txt', 'a/2.txt'])

		const grouped = await (await request('GET', `/${bucket}?uploads&delimiter=/`)).text()
		expect(uploadKeys(grouped)).toEqual(['b.txt'])
		expect(grouped).toContain('<CommonPrefixes><Prefix>a/</Prefix></CommonPrefixes>')
	})

	test('ListMultipartUploads pages through uploads with the key and upload ID markers', async () => {
		const bucket = await newBucketForUpload()
		const first = await start(bucket, 'same.txt')
		const second = await start(bucket, 'same.txt')
		await start(bucket, 'z.txt')

		const page1 = await (await request('GET', `/${bucket}?uploads&max-uploads=1`)).text()
		expect(uploadKeys(page1)).toEqual(['same.txt'])
		expect(page1).toContain('<IsTruncated>true</IsTruncated>')
		const [firstListed] = uploadIds(page1)
		expect([first, second]).toContain(firstListed!)
		expect(page1).toContain('<NextKeyMarker>same.txt</NextKeyMarker>')
		expect(page1).toContain(`<NextUploadIdMarker>${firstListed}</NextUploadIdMarker>`)

		const page2 = await (await request('GET', `/${bucket}?uploads&max-uploads=1&key-marker=same.txt&upload-id-marker=${firstListed}`)).text()
		expect(uploadKeys(page2)).toEqual(['same.txt'])
		expect(new Set([firstListed, uploadIds(page2)[0]])).toEqual(new Set([first, second]))

		const page3 = await (await request('GET', `/${bucket}?uploads&max-uploads=5&key-marker=same.txt&upload-id-marker=${uploadIds(page2)[0]}`)).text()
		expect(uploadKeys(page3)).toEqual(['z.txt'])
		expect(page3).toContain('<IsTruncated>false</IsTruncated>')
	})

	test('ListMultipartUploads in a missing bucket returns NoSuchBucket', async () => {
		const res = await request('GET', `/${newBucket()}?uploads`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucket')
	})

	test('uploads older than UPLOAD_EXPIRY_DAYS are aborted and their parts removed', async () => {
		const bucket = await newBucketForUpload()
		const old = {
			upload_id: `expired${crypto.randomUUID().replaceAll('-', '')}`,
			bucket,
			key: 'old.txt',
			content_type: 'text/plain',
			created_at: new Date(Date.now() - (config.uploadExpiryDays + 1) * 24 * 60 * 60 * 1000).toISOString(),
		}
		uploads.create(old)
		uploads.putPart({ upload_id: old.upload_id, part_number: 1, size: 1, etag: md5('x') })
		const oldFolder = join(config.uploadsDir, old.upload_id)
		mkdirSync(oldFolder, { recursive: true })
		writeFileSync(join(oldFolder, '1'), 'x')
		// The upload is abandoned: it was started long ago and its newest part is just as old.
		utimesSync(join(oldFolder, '1'), new Date(old.created_at), new Date(old.created_at))
		const fresh = await start(bucket, 'fresh.txt')

		expect(await expireUploads()).toBeGreaterThanOrEqual(1)
		expect(uploads.get(old.upload_id)).toBeNull()
		expect(uploads.parts(old.upload_id)).toEqual([])
		expect(existsSync(oldFolder)).toBe(false)
		expect(uploads.get(fresh)).not.toBeNull()
	})

	test('with UPLOAD_EXPIRY_DAYS at 0, old uploads are kept', async () => {
		const bucket = await newBucketForUpload()
		const old = {
			upload_id: `keep${crypto.randomUUID().replaceAll('-', '')}`,
			bucket,
			key: 'keep.txt',
			content_type: 'text/plain',
			created_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
		}
		uploads.create(old)
		const days = config.uploadExpiryDays
		config.uploadExpiryDays = 0
		try {
			await expireUploads()
			expect(uploads.get(old.upload_id)).not.toBeNull()
		} finally {
			config.uploadExpiryDays = days
			uploads.remove(old.upload_id)
		}
	})

	test('a part folder that no upload owns is removed after an hour, not before', async () => {
		mkdirSync(config.uploadsDir, { recursive: true })
		const stale = join(config.uploadsDir, `orphan-old-${crypto.randomUUID()}`)
		const recent = join(config.uploadsDir, `orphan-new-${crypto.randomUUID()}`)
		mkdirSync(stale)
		mkdirSync(recent)
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
		utimesSync(stale, twoHoursAgo, twoHoursAgo)

		try {
			await expireUploads()
			expect(existsSync(stale)).toBe(false)
			expect(existsSync(recent)).toBe(true)
		} finally {
			rmSync(recent, { recursive: true, force: true })
		}
	})

	test('an old upload that is still receiving parts is not expired', async () => {
		const bucket = await newBucketForUpload()
		const busy = {
			upload_id: `busy${crypto.randomUUID().replaceAll('-', '')}`,
			bucket,
			key: 'busy.txt',
			content_type: 'text/plain',
			created_at: new Date(Date.now() - (config.uploadExpiryDays + 1) * 24 * 60 * 60 * 1000).toISOString(),
		}
		uploads.create(busy)
		uploads.putPart({ upload_id: busy.upload_id, part_number: 1, size: 1, etag: md5('x') })
		const folder = join(config.uploadsDir, busy.upload_id)
		mkdirSync(folder, { recursive: true })
		writeFileSync(join(folder, '1'), 'x') // written just now

		try {
			await expireUploads()
			expect(uploads.get(busy.upload_id)).not.toBeNull()
			expect(existsSync(folder)).toBe(true)
		} finally {
			uploads.remove(busy.upload_id)
			rmSync(folder, { recursive: true, force: true })
		}
	})

	// A request body that arrives in pieces, with a pause between them. It is signed with the hash of the whole body.
	function slowBody(first: string, second: string, pauseMs: number): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder()
		return new ReadableStream({
			async start(controller) {
				controller.enqueue(encoder.encode(first))
				await Bun.sleep(pauseMs)
				controller.enqueue(encoder.encode(second))
				controller.close()
			},
		})
	}
	const sha256 = (data: string) => new Bun.CryptoHasher('sha256').update(data).digest('hex')

	test('an abort waits for a part that is being written, and leaves nothing behind', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'race.txt')
		const url = `/${bucket}/race.txt?partNumber=1&uploadId=${uploadId}`

		const part = request('PUT', url, { body: slowBody('slow ', 'part', 400), duplex: 'half' } as RequestInit, { payloadHash: sha256('slow part') })
		await Bun.sleep(100)
		const abort = request('DELETE', `/${bucket}/race.txt?uploadId=${uploadId}`)

		// The part is still arriving, so the abort has to wait for it instead of deleting the upload underneath it.
		const early = await Promise.race([abort.then(() => 'finished'), Bun.sleep(100).then(() => 'waiting')])
		expect(early).toBe('waiting')

		expect((await part).status).toBe(200)
		expect((await abort).status).toBe(204)
		expect(uploads.get(uploadId)).toBeNull()
		expect(uploads.parts(uploadId)).toEqual([])
		expect(existsSync(join(config.uploadsDir, uploadId))).toBe(false)
	})

	test('two Completes at once: one succeeds, the other gets NoSuchUpload, and nobody gets a server error', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'twice.txt')
		await putPart(bucket, 'twice.txt', uploadId, 1, 'only part')

		const results = await Promise.all([
			complete(bucket, 'twice.txt', uploadId, [[1, md5('only part')]]),
			complete(bucket, 'twice.txt', uploadId, [[1, md5('only part')]]),
		])
		expect(results.map(res => res.status).sort()).toEqual([200, 404])
		expect(await (await request('GET', `/${bucket}/twice.txt`)).text()).toBe('only part')
	})

	test('Complete and Abort at once: one wins and the upload is gone, with no server error', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'either.txt')
		await putPart(bucket, 'either.txt', uploadId, 1, 'data')

		const [done, aborted] = await Promise.all([
			complete(bucket, 'either.txt', uploadId, [[1, md5('data')]]),
			request('DELETE', `/${bucket}/either.txt?uploadId=${uploadId}`),
		])
		expect([done.status, aborted.status]).not.toContain(500)
		expect([done.status, aborted.status]).toContain(404)
		expect((await request('GET', `/${bucket}/either.txt`)).status).toBe(done.status === 200 ? 200 : 404)
		expect(uploads.get(uploadId)).toBeNull()
		expect(existsSync(join(config.uploadsDir, uploadId))).toBe(false)
	})

	test('a PUT with only uploadId or only partNumber is rejected and does not overwrite the object', async () => {
		const bucket = await newBucketForUpload()
		await request('PUT', `/${bucket}/keep.txt`, { body: 'original' })
		const uploadId = await start(bucket, 'keep.txt')

		for (const query of [`uploadId=${uploadId}`, 'partNumber=1', 'uploadId=typo']) {
			const res = await request('PUT', `/${bucket}/keep.txt?${query}`, { body: 'overwritten' })
			expect(res.status).toBe(400)
			expect(code(await res.text())).toBe('InvalidArgument')
		}
		expect(await (await request('GET', `/${bucket}/keep.txt`)).text()).toBe('original')
	})

	test('a parts list over the size limit is rejected without reading it all', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'big-list.txt')
		const url = `/${bucket}/big-list.txt?uploadId=${uploadId}`

		const byLength = await request('POST', url, { body: 'x'.repeat(1024 * 1024 + 1) })
		expect(byLength.status).toBe(400)
		expect(code(await byLength.text())).toBe('EntityTooLarge')

		// No Content-Length: the body is read only up to the limit.
		const half = 'x'.repeat(600 * 1024)
		const streamed = await request('POST', url, { body: slowBody(half, half, 10), duplex: 'half' } as RequestInit, { payloadHash: sha256(half + half) })
		expect(streamed.status).toBe(400)
		expect(code(await streamed.text())).toBe('EntityTooLarge')
	})

	test('a page size of 0 is an empty page that is not truncated', async () => {
		const bucket = await newBucketForUpload()
		await request('PUT', `/${bucket}/a.txt`, { body: 'a' })
		const uploadId = await start(bucket, 'z.txt')
		await putPart(bucket, 'z.txt', uploadId, 1, 'x')

		const parts = await (await request('GET', `/${bucket}/z.txt?uploadId=${uploadId}&max-parts=0`)).text()
		expect(partNumbers(parts)).toEqual([])
		expect(parts).toContain('<IsTruncated>false</IsTruncated>')
		expect(parts).not.toContain('NextPartNumberMarker')

		const listed = await (await request('GET', `/${bucket}?uploads&max-uploads=0`)).text()
		expect(uploadKeys(listed)).toEqual([])
		expect(listed).toContain('<IsTruncated>false</IsTruncated>')
		expect(listed).not.toContain('NextKeyMarker')

		const objectsPage = await (await request('GET', `/${bucket}?list-type=2&max-keys=0`)).text()
		expect(objectsPage).toContain('<IsTruncated>false</IsTruncated>')
		expect(objectsPage).not.toContain('NextContinuationToken')
	})

	test('a broken percent sequence in the copy source or the path is a 400, not a server error', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'dest.txt')

		const partCopy = await copyPart(bucket, 'dest.txt', uploadId, 1, '/%E0%A4%A')
		expect(partCopy.status).toBe(400)
		expect(code(await partCopy.text())).toBe('InvalidArgument')

		const objectCopy = await request('PUT', `/${bucket}/copy.txt`, { headers: { 'x-amz-copy-source': '/%E0%A4%A' } })
		expect(objectCopy.status).toBe(400)
		expect(code(await objectCopy.text())).toBe('InvalidArgument')

		const path = await request('GET', `/${bucket}/%E0%A4%A`)
		expect(path.status).toBe(400)
		expect(code(await path.text())).toBe('InvalidURI')
	})

	test('Complete rejects a part file that no longer matches what was recorded for it', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'drift.txt')
		await putPart(bucket, 'drift.txt', uploadId, 1, 'abc')
		writeFileSync(join(config.uploadsDir, uploadId, '1'), 'abcdef') // changed behind the database's back

		const done = await complete(bucket, 'drift.txt', uploadId, [[1, md5('abc')]])
		expect(done.status).toBe(400)
		expect(code(await done.text())).toBe('InvalidPart')
		expect((await request('GET', `/${bucket}/drift.txt`)).status).toBe(404)
	})

	test('part numbers are digits only, and leading zeros name the same part', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'digits.txt')
		for (const bad of ['', ' 1', '1e3', '1.0', '+1', '0x1']) {
			const res = await putPart(bucket, 'digits.txt', uploadId, encodeURIComponent(bad), 'x')
			expect(res.status).toBe(400)
			expect(code(await res.text())).toBe('InvalidArgument')
		}

		expect((await putPart(bucket, 'digits.txt', uploadId, '01', 'zero padded')).status).toBe(200)
		expect((await complete(bucket, 'digits.txt', uploadId, [[1, md5('zero padded')]])).status).toBe(200)
		expect(await (await request('GET', `/${bucket}/digits.txt`)).text()).toBe('zero padded')
	})

	test('ListMultipartUploads matches a prefix with characters outside the basic plane', async () => {
		const bucket = await newBucketForUpload()
		for (const key of ['😀/one.txt', '😀/two.txt', 'plain.txt']) await start(bucket, encodeURI(key))

		const listed = await (await request('GET', `/${bucket}?uploads&prefix=${encodeURIComponent('😀/')}`)).text()
		expect(uploadKeys(listed)).toEqual(['😀/one.txt', '😀/two.txt'])
	})

	test('ListMultipartUploads with a delimiter reads in batches and pages past a whole common prefix', async () => {
		const bucket = await newBucketForUpload()
		const created = new Date().toISOString()
		// More uploads under one prefix than one batch reads.
		for (let i = 0; i < 1200; i++) {
			uploads.create({ upload_id: `batch${i}-${bucket}`, bucket, key: `many/k${String(i).padStart(4, '0')}`, content_type: 'x', created_at: created })
		}
		await start(bucket, 'zzz.txt')

		const all = await (await request('GET', `/${bucket}?uploads&delimiter=/`)).text()
		expect(all).toContain('<CommonPrefixes><Prefix>many/</Prefix></CommonPrefixes>')
		expect(uploadKeys(all)).toEqual(['zzz.txt'])
		expect(all).toContain('<IsTruncated>false</IsTruncated>')

		const page1 = await (await request('GET', `/${bucket}?uploads&delimiter=/&max-uploads=1`)).text()
		expect(page1).toContain('<Prefix>many/</Prefix>')
		expect(page1).toContain('<IsTruncated>true</IsTruncated>')
		expect(page1).toContain('<NextKeyMarker>many/</NextKeyMarker>')

		const page2 = await (await request('GET', `/${bucket}?uploads&delimiter=/&max-uploads=1&key-marker=${encodeURIComponent('many/')}`)).text()
		expect(uploadKeys(page2)).toEqual(['zzz.txt'])
		expect(page2).toContain('<IsTruncated>false</IsTruncated>')
	})

	test('UPLOAD_EXPIRY_DAYS defaults to 7, accepts 0, and rejects a negative or non-numeric value', () => {
		const base = { ACCESS_KEY_ID: 'a', SECRET_ACCESS_KEY: 'b' }
		expect(loadConfig(base).uploadExpiryDays).toBe(7)
		expect(loadConfig({ ...base, UPLOAD_EXPIRY_DAYS: '0' }).uploadExpiryDays).toBe(0)
		expect(loadConfig({ ...base, UPLOAD_EXPIRY_DAYS: '2.5' }).uploadExpiryDays).toBe(2.5)
		expect(() => loadConfig({ ...base, UPLOAD_EXPIRY_DAYS: '-1' })).toThrow('UPLOAD_EXPIRY_DAYS')
		expect(() => loadConfig({ ...base, UPLOAD_EXPIRY_DAYS: 'soon' })).toThrow('UPLOAD_EXPIRY_DAYS')
	})

	test('a backup leaves out the parts of uploads in progress', async () => {
		const bucket = await newBucketForUpload()
		const uploadId = await start(bucket, 'bk.txt')
		await putPart(bucket, 'bk.txt', uploadId, 1, 'in progress')
		expect(existsSync(join(config.uploadsDir, uploadId, '1'))).toBe(true)

		const dest = mkdtempSync(join(tmpdir(), 's3-backup-'))
		try {
			backup(join(dest, 'copy'))
			expect(existsSync(join(dest, 'copy', 'uploads'))).toBe(false)
			expect(existsSync(join(dest, 'copy', 'buckets'))).toBe(true)
		} finally {
			rmSync(dest, { recursive: true, force: true })
		}
	})
})

describe('range requests', () => {
	test('a byte range returns 206 with the requested bytes', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'hello world' })

		const range = await request('GET', `/${name}/a.txt`, { headers: { Range: 'bytes=0-4' } })
		expect(range.status).toBe(206)
		expect(range.headers.get('content-range')).toBe('bytes 0-4/11')
		expect(range.headers.get('content-length')).toBe('5')
		expect(await range.text()).toBe('hello')

		const open = await request('GET', `/${name}/a.txt`, { headers: { Range: 'bytes=6-' } })
		expect(await open.text()).toBe('world')

		const suffix = await request('GET', `/${name}/a.txt`, { headers: { Range: 'bytes=-5' } })
		expect(await suffix.text()).toBe('world')
	})

	test('a range past the end returns 416', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'hello' })

		const res = await request('GET', `/${name}/a.txt`, { headers: { Range: 'bytes=20-30' } })
		expect(res.status).toBe(416)
		expect(res.headers.get('content-range')).toBe('bytes */5')
	})

	test('without a range the whole object is returned and ranges are advertised', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'hello' })

		const res = await request('GET', `/${name}/a.txt`)
		expect(res.status).toBe(200)
		expect(res.headers.get('accept-ranges')).toBe('bytes')
		expect(await res.text()).toBe('hello')
	})
})

describe('copy object', () => {
	test('copies bytes and content type to a new key, with the same etag', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'hello', headers: { 'Content-Type': 'text/plain' } })
		const md5 = new Bun.CryptoHasher('md5').update('hello').digest('hex')

		const res = await request('PUT', `/${name}/copies/b.txt`, { headers: { 'x-amz-copy-source': `/${name}/a.txt` } })
		expect(res.status).toBe(200)
		expect(await res.text()).toContain(`<ETag>"${md5}"</ETag>`)

		const get = await request('GET', `/${name}/copies/b.txt`)
		expect(await get.text()).toBe('hello')
		expect(get.headers.get('content-type')).toBe('text/plain')
	})

	test('copying a missing source returns NoSuchKey', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)

		const res = await request('PUT', `/${name}/b.txt`, { headers: { 'x-amz-copy-source': `/${name}/nope.txt` } })
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchKey')
	})
})

describe('list objects', () => {
	test('prefix and delimiter group keys into common prefixes', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		for (const key of ['a/1', 'a/2', 'a/sub/3', 'b.txt']) {
			await request('PUT', `/${name}/${key}`, { body: 'x' })
		}

		const xml = await (await request('GET', `/${name}?prefix=a/&delimiter=/`)).text()
		expect(keys(xml)).toEqual(['a/1', 'a/2'])
		expect(xml).toContain('<CommonPrefixes><Prefix>a/sub/</Prefix></CommonPrefixes>')
	})

	test('pages through every key with continuation tokens', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		const all = ['k1', 'k2', 'k3', 'k4', 'k5']
		for (const key of all) {
			await request('PUT', `/${name}/${key}`, { body: 'x' })
		}

		const seen: string[] = []
		let token: string | undefined
		do {
			const qs = new URLSearchParams({ 'max-keys': '2' })
			if (token) qs.set('continuation-token', token)
			const xml = await (await request('GET', `/${name}?${qs}`)).text()
			seen.push(...keys(xml))
			token = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1]
		} while (token)

		expect(seen).toEqual(all)
	})

	test('a trailing slash lists the bucket', async () => {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'x' })

		const res = await request('GET', `/${name}/`)
		expect(res.status).toBe(200)
		expect(keys(await res.text())).toEqual(['a.txt'])
	})

	test('listing a missing bucket returns NoSuchBucket', async () => {
		const res = await request('GET', `/${newBucket()}`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucket')
	})
})

describe('public buckets', () => {
	const policyFor = (bucket: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
		Version: '2012-10-17',
		Statement: [{
			Effect: 'Allow',
			Principal: '*',
			Action: 's3:GetObject',
			Resource: `arn:aws:s3:::${bucket}/*`,
			...overrides,
		}],
	})
	const anon = (method: string, path: string, init: RequestInit = {}) =>
		fetch(new URL(path, server.url), { ...init, method })

	// A private bucket with one file, and a public one with the same file.
	async function bucketWithFile(publicRead: boolean) {
		const name = newBucket()
		await request('PUT', `/${name}`)
		await request('PUT', `/${name}/a.txt`, { body: 'hello world', headers: { 'Content-Type': 'text/plain' } })
		if (publicRead) {
			const res = await request('PUT', `/${name}?policy`, { body: policyFor(name) })
			expect(res.status).toBe(204)
		}
		return name
	}

	test('AC-1: anonymous GET on a private bucket returns AccessDenied', async () => {
		const name = await bucketWithFile(false)
		const res = await anon('GET', `/${name}/a.txt`)
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('AccessDenied')
	})

	test('AC-2: anonymous GET on a public bucket returns the object, with its content type', async () => {
		const name = await bucketWithFile(true)
		const res = await anon('GET', `/${name}/a.txt`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('text/plain')
		expect(await res.text()).toBe('hello world')
	})

	test('AC-3: anonymous HEAD on a public bucket returns headers only', async () => {
		const name = await bucketWithFile(true)
		const res = await anon('HEAD', `/${name}/a.txt`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-length')).toBe('11')
		expect(await res.text()).toBe('')
	})

	test('AC-4: anonymous Range read returns 206 with the requested bytes', async () => {
		const name = await bucketWithFile(true)
		const res = await anon('GET', `/${name}/a.txt`, { headers: { Range: 'bytes=0-4' } })
		expect(res.status).toBe(206)
		expect(await res.text()).toBe('hello')
	})

	test('AC-5: anonymous listing is refused even on a public bucket', async () => {
		const name = await bucketWithFile(true)
		const res = await anon('GET', `/${name}`)
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('AccessDenied')
	})

	test('AC-6: anonymous PUT and DELETE are refused and change nothing', async () => {
		const name = await bucketWithFile(true)
		const put = await anon('PUT', `/${name}/b.txt`, { body: 'x' })
		expect(put.status).toBe(403)
		const del = await anon('DELETE', `/${name}/a.txt`)
		expect(del.status).toBe(403)

		const head = await request('HEAD', `/${name}/b.txt`)
		expect(head.status).toBe(404)
		const still = await request('GET', `/${name}/a.txt`)
		expect(await still.text()).toBe('hello world')
	})

	test('AC-7: a signed PutBucketPolicy makes the bucket readable anonymously', async () => {
		const name = await bucketWithFile(false)
		expect((await anon('GET', `/${name}/a.txt`)).status).toBe(403)

		const put = await request('PUT', `/${name}?policy`, { body: policyFor(name) })
		expect(put.status).toBe(204)
		expect((await anon('GET', `/${name}/a.txt`)).status).toBe(200)
	})

	test('AC-8: a policy that allows ListBucket is refused and not stored', async () => {
		const name = await bucketWithFile(false)
		const body = JSON.stringify({
			Version: '2012-10-17',
			Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject', 's3:ListBucket'], Resource: `arn:aws:s3:::${name}/*` }],
		})
		const res = await request('PUT', `/${name}?policy`, { body })
		expect(res.status).toBe(501)
		expect(code(await res.text())).toBe('NotImplemented')
		expect((await request('GET', `/${name}?policy`)).status).toBe(404)
	})

	test('AC-9: a policy with a Condition or a Deny is refused and not stored', async () => {
		const name = await bucketWithFile(false)
		const withCondition = policyFor(name, { Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } } })
		const withDeny = policyFor(name, { Effect: 'Deny' })

		for (const body of [withCondition, withDeny]) {
			const res = await request('PUT', `/${name}?policy`, { body })
			expect(res.status).toBe(501)
			expect(code(await res.text())).toBe('NotImplemented')
		}
		expect((await request('GET', `/${name}?policy`)).status).toBe(404)
	})

	test('AC-10: a policy that is not valid JSON returns MalformedPolicy and is not stored', async () => {
		const name = await bucketWithFile(false)
		const res = await request('PUT', `/${name}?policy`, { body: '{not json' })
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('MalformedPolicy')
		expect((await request('GET', `/${name}?policy`)).status).toBe(404)
	})

	test('AC-11: an unsigned PutBucketPolicy returns 403', async () => {
		const name = await bucketWithFile(false)
		const res = await anon('PUT', `/${name}?policy`, { body: policyFor(name) })
		expect(res.status).toBe(403)
		expect((await anon('GET', `/${name}/a.txt`)).status).toBe(403)
	})

	test('AC-12: after DeleteBucketPolicy, anonymous reads are refused again', async () => {
		const name = await bucketWithFile(true)
		expect((await anon('GET', `/${name}/a.txt`)).status).toBe(200)

		const del = await request('DELETE', `/${name}?policy`)
		expect(del.status).toBe(204)
		const res = await anon('GET', `/${name}/a.txt`)
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('AccessDenied')
	})

	test('AC-13: a bad signature on a public bucket is refused, not treated as anonymous', async () => {
		const name = await bucketWithFile(true)
		const res = await request('GET', `/${name}/a.txt`, {}, { creds: { ...defaultCreds(), secretAccessKey: 'wrong' } })
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('SignatureDoesNotMatch')
	})

	test('AC-14: an anonymous read of a missing bucket returns the same AccessDenied as a private bucket', async () => {
		const res = await anon('GET', `/${newBucket()}/a.txt`)
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('AccessDenied')
	})

	test('AC-15: GetBucketPolicy on a bucket with no policy returns NoSuchBucketPolicy', async () => {
		const name = await bucketWithFile(false)
		const res = await request('GET', `/${name}?policy`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucketPolicy')
	})

	test('GetBucketPolicy returns the stored policy as JSON', async () => {
		const name = await bucketWithFile(true)
		const res = await request('GET', `/${name}?policy`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('application/json')
		expect(JSON.parse(await res.text())).toEqual(JSON.parse(policyFor(name)))
	})

	test('a policy for another bucket is refused as malformed', async () => {
		const name = await bucketWithFile(false)
		const res = await request('PUT', `/${name}?policy`, { body: policyFor('some-other-bucket') })
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('MalformedPolicy')
	})

	test('a policy for another principal is refused as not implemented', async () => {
		const name = await bucketWithFile(false)
		const res = await request('PUT', `/${name}?policy`, { body: policyFor(name, { Principal: { AWS: 'arn:aws:iam::123:root' } }) })
		expect(res.status).toBe(501)
	})

	test('a policy over 20 KB is refused as malformed', async () => {
		const name = await bucketWithFile(false)
		const body = policyFor(name, { Sid: 'x'.repeat(21 * 1024) })
		const res = await request('PUT', `/${name}?policy`, { body })
		expect(res.status).toBe(400)
		expect(code(await res.text())).toBe('MalformedPolicy')
	})

	test('a policy PUT to a missing bucket returns NoSuchBucket', async () => {
		const name = newBucket()
		const res = await request('PUT', `/${name}?policy`, { body: policyFor(name) })
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucket')
	})

	test('an anonymous read of a missing key in a public bucket returns NoSuchKey', async () => {
		const name = await bucketWithFile(true)
		const res = await anon('GET', `/${name}/missing.txt`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchKey')
	})

	test('anonymous reads carry Cache-Control; signed reads do not', async () => {
		const name = await bucketWithFile(true)
		const open = await anon('GET', `/${name}/a.txt`)
		expect(open.headers.get('cache-control')).toBe('public, max-age=86400')

		const signed = await request('GET', `/${name}/a.txt`)
		expect(signed.headers.get('cache-control')).toBeNull()
	})

	test('an anonymous request with a subresource is not treated as a public read', async () => {
		const name = await bucketWithFile(true)
		const res = await anon('GET', `/${name}/a.txt?uploads`)
		expect(res.status).toBe(403)
	})

	test('an expired presigned URL on a public bucket is refused, not treated as anonymous', async () => {
		const name = await bucketWithFile(true)
		const old = amzDateFor(new Date(Date.now() - 10 * 60 * 1000))
		const res = await fetch(presignedUrl('GET', `/${name}/a.txt`, { expires: 60, amzDate: old }))
		expect(res.status).toBe(403)
		expect(code(await res.text())).toBe('AccessDenied')
	})

	test('a valid presigned URL still works on a private bucket', async () => {
		const name = await bucketWithFile(false)
		const res = await fetch(presignedUrl('GET', `/${name}/a.txt`))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('hello world')
	})
})
