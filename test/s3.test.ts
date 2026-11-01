import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { backup } from '../src/backup'
import { config, loadConfig } from '../src/config'
import { server } from '../src/index'
import { signatureFor } from '../src/s3/auth'
import { objectPath, writeObject } from '../src/storage'

// Remove the temp data folder after the run, even if tests failed.
// Set KEEP_TEST_DATA=1 to keep it for inspection.
afterAll(() => {
	const dir = Bun.env.TEST_DATA_DIR
	if (dir && !Bun.env.KEEP_TEST_DATA) rmSync(dir, { recursive: true, force: true })
})

type Creds = { accessKeyId: string, secretAccessKey: string }
type SignOptions = { creds?: Creds, amzDate?: string, signPath?: string }

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
	const payloadHash = 'UNSIGNED-PAYLOAD'
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

function request(method: string, path: string, init: RequestInit = {}, options: SignOptions = {}) {
	const headers = new Headers(init.headers)
	for (const [name, value] of Object.entries(authHeaders(method, path, options))) headers.set(name, value)
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
