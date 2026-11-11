import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { backup } from '../src/backup'
import { config, loadConfig } from '../src/config'
import { server } from '../src/index'
import { signatureFor } from '../src/s3/auth'
import { checksumFor } from '../src/s3/chunked'
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

	test('LOG_DIR and BACKUP_DIR override their defaults', () => {
		const c = loadConfig({ DATA_DIR: '/srv/store', LOG_DIR: '/var/log/s3', BACKUP_DIR: '/mnt/b', ACCESS_KEY_ID: 'a', SECRET_ACCESS_KEY: 'b' })
		expect(c.logDir).toBe('/var/log/s3')
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

	test('each request line is also appended to LOG_DIR/server.log', async () => {
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
