import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { config } from '../src/config'
import { server } from '../src/index'
import { objectPath } from '../src/storage'

// Remove the temp data folder after the run, even if tests failed.
// Set KEEP_TEST_DATA=1 to keep it for inspection.
afterAll(() => {
	const dir = Bun.env.TEST_DATA_DIR
	if (dir && !Bun.env.KEEP_TEST_DATA) rmSync(dir, { recursive: true, force: true })
})

const newBucket = () => `t-${crypto.randomUUID().slice(0, 8)}`

function request(method: string, path: string, init: RequestInit = {}) {
	return fetch(new URL(path, server.url), { method, ...init })
}

function code(xml: string) {
	return xml.match(/<Code>(.*?)<\/Code>/)?.[1]
}

function keys(xml: string) {
	return [...xml.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1] ?? '')
}

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

	test('listing a missing bucket returns NoSuchBucket', async () => {
		const res = await request('GET', `/${newBucket()}`)
		expect(res.status).toBe(404)
		expect(code(await res.text())).toBe('NoSuchBucket')
	})
})
