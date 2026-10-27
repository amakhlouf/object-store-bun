import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { config } from '../src/config'
import { server } from '../src/index'
import { signatureFor } from '../src/s3/auth'
import { objectPath } from '../src/storage'

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

	test('keys that escape the bucket folder are rejected', () => {
		expect(() => objectPath('/data', 'photos', '../secret')).toThrow('Invalid Argument')
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
