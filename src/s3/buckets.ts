import type { BunRequest } from 'bun'
import { buckets, uploads } from '../db'
import { deleteBucketPolicy, isPolicyRequest, putBucketPolicy } from './bucket-policy'
import { S3Error } from './errors'
import { xmlResponse } from './responses'

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const OWNER = { ID: 'local', DisplayName: 'local' }

export function listBuckets(): Response {
	const rows = buckets.list()
	return xmlResponse({
		ListAllMyBucketsResult: {
			'@xmlns': 'http://s3.amazonaws.com/doc/2006-03-01/',
			Owner: OWNER,
			Buckets: {
				Bucket: rows.map(b => ({ Name: b.name, CreationDate: b.created_at })),
			},
		},
	})
}

export function createBucket(req: BunRequest<'/:bucket'>): Response | Promise<Response> {
	if (isPolicyRequest(req)) return putBucketPolicy(req)

	const name = req.params.bucket
	validateBucketName(name)
	assertBucketNotExists(name)

	buckets.insert(name, new Date().toISOString())
	return new Response(null, { status: 200, headers: { Location: `/${name}` } })
}

export function headBucket(req: BunRequest<'/:bucket'>): Response {
	assertBucketExists(req.params.bucket)
	return new Response(null, { status: 200 })
}

export function deleteBucket(req: BunRequest<'/:bucket'>): Response {
	if (isPolicyRequest(req)) return deleteBucketPolicy(req)

	const name = req.params.bucket
	assertBucketExists(name)
	assertBucketEmpty(name)

	buckets.remove(name)
	return new Response(null, { status: 204 })
}

function validateBucketName(name: string): void {
	if (!BUCKET_NAME.test(name) || name.includes('..')) {
		throw new S3Error('InvalidBucketName', 400, 'The specified bucket is not valid.', `/${name}`)
	}
}

function assertBucketNotExists(name: string): void {
	const exists = buckets.exists(name)
	if (exists) {
		throw new S3Error('BucketAlreadyExists', 409, 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.', `/${name}`)
	}
}

function assertBucketExists(name: string): void {
	const exists = buckets.exists(name)
	if (!exists) {
		throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist.', `/${name}`)
	}
}

function assertBucketEmpty(name: string): void {
	// Uploads in progress count too: their rows and parts would be left behind, and a bucket created again under this
	// name would show them.
	const objectCount = buckets.countObjects(name) + uploads.countInBucket(name)
	if (objectCount > 0) {
		throw new S3Error('BucketNotEmpty', 409, 'The bucket you tried to delete is not empty.', `/${name}`)
	}
}
