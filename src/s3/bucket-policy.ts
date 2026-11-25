import type { BunRequest } from 'bun'
import { buckets } from '../db'
import { isSignedRequest } from './auth'
import { S3Error } from './errors'
import { assertBucketExists, objectKey } from './lookup'
import { uploadBody } from './upload-body'

const POLICY_VERSION = '2012-10-17'
const POLICY_ACTION = 's3:GetObject'
const MAX_POLICY_BYTES = 20 * 1024
const POLICY_KEYS = new Set(['Version', 'Id', 'Statement'])
const STATEMENT_KEYS = new Set(['Sid', 'Effect', 'Principal', 'Action', 'Resource', 'Condition'])

// Sent on anonymous object reads only. Objects are never changed under the same key, so caching a day is safe.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=86400'

function malformed(message: string): S3Error {
	return new S3Error('MalformedPolicy', 400, message)
}

function notImplemented(message: string): S3Error {
	return new S3Error('NotImplemented', 501, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A policy field that holds one string or a list of strings.
function stringList(value: unknown, name: string): string[] {
	const list = typeof value === 'string' ? [value] : value
	if (!Array.isArray(list) || list.length === 0 || !list.every(item => typeof item === 'string')) {
		throw malformed(`${name} must be a string or a non-empty list of strings.`)
	}
	return list as string[]
}

function isPublicPrincipal(principal: unknown): boolean {
	if (principal === '*') return true
	return isRecord(principal) && Object.keys(principal).length === 1 && principal.AWS === '*'
}

// Checks one statement against the accepted subset. Returns it in the normal form that is stored.
function normalizeStatement(statement: unknown, bucket: string): Record<string, string> {
	if (!isRecord(statement)) throw malformed('Each statement must be a JSON object.')
	for (const key of Object.keys(statement)) {
		if (!STATEMENT_KEYS.has(key)) throw malformed(`Unknown statement element ${key}.`)
	}
	if (statement.Condition !== undefined) throw notImplemented('Policy conditions are not supported.')
	if (statement.Effect === 'Deny') throw notImplemented('Deny statements are not supported.')
	if (statement.Effect !== 'Allow') throw malformed('Effect must be Allow.')
	if (statement.Sid !== undefined && typeof statement.Sid !== 'string') throw malformed('Sid must be a string.')

	if (statement.Principal === undefined) throw malformed('Principal is required.')
	if (!isPublicPrincipal(statement.Principal)) throw notImplemented('Only the principal * is supported.')

	const actions = stringList(statement.Action, 'Action')
	if (actions.some(action => action !== POLICY_ACTION)) {
		throw notImplemented(`Only ${POLICY_ACTION} is supported.`)
	}

	const resources = stringList(statement.Resource, 'Resource')
	const resource = `arn:aws:s3:::${bucket}/*`
	if (resources.length !== 1 || resources[0] !== resource) {
		throw malformed(`Resource must be ${resource}.`)
	}

	const normalized: Record<string, string> = {}
	if (statement.Sid !== undefined) normalized.Sid = statement.Sid as string
	normalized.Effect = 'Allow'
	normalized.Principal = '*'
	normalized.Action = POLICY_ACTION
	normalized.Resource = resource
	return normalized
}

// Returns the policy as stored (normalized JSON), or throws the error for the first thing outside the accepted subset.
export function parseBucketPolicy(text: string, bucket: string): string {
	if (new TextEncoder().encode(text).byteLength > MAX_POLICY_BYTES) {
		throw malformed('The policy document is larger than 20 KB.')
	}

	let document: unknown
	try {
		document = JSON.parse(text)
	} catch {
		throw malformed('The policy document is not valid JSON.')
	}
	if (!isRecord(document)) throw malformed('The policy document must be a JSON object.')
	for (const key of Object.keys(document)) {
		if (!POLICY_KEYS.has(key)) throw malformed(`Unknown policy element ${key}.`)
	}
	if (document.Version !== POLICY_VERSION) throw malformed(`Version must be ${POLICY_VERSION}.`)
	if (document.Id !== undefined && typeof document.Id !== 'string') throw malformed('Id must be a string.')
	if (!Array.isArray(document.Statement) || document.Statement.length === 0) {
		throw malformed('Statement must be a non-empty list.')
	}

	const statements = document.Statement.map(statement => normalizeStatement(statement, bucket))
	return JSON.stringify({ Version: POLICY_VERSION, Statement: statements })
}

// The policy document is read the same way as an upload body: it must be signed, and its hash must match.
async function readPolicyText(req: Request, resource: string): Promise<string> {
	const { body, sha256 } = uploadBody(req, resource)
	const hasher = sha256 ? new Bun.CryptoHasher('sha256') : null
	const chunks: Uint8Array[] = []
	let size = 0

	if (body) {
		for await (const chunk of body) {
			size += chunk.byteLength
			if (size > MAX_POLICY_BYTES) throw malformed('The policy document is larger than 20 KB.')
			hasher?.update(chunk)
			chunks.push(chunk)
		}
	}
	if (hasher && hasher.digest('hex') !== sha256?.toLowerCase()) {
		throw new S3Error('XAmzContentSHA256Mismatch', 400, "The provided 'x-amz-content-sha256' header does not match what was computed.")
	}
	return new TextDecoder().decode(Buffer.concat(chunks))
}

// True for the ?policy subresource, which PutBucketPolicy, GetBucketPolicy and DeleteBucketPolicy use.
export function isPolicyRequest(req: Request): boolean {
	return new URL(req.url).searchParams.has('policy')
}

export async function putBucketPolicy(req: BunRequest<'/:bucket'>): Promise<Response> {
	const bucket = req.params.bucket
	assertBucketExists(bucket)

	const policy = parseBucketPolicy(await readPolicyText(req, `/${bucket}`), bucket)
	buckets.setPolicy(bucket, policy)
	return new Response(null, { status: 204 })
}

export function getBucketPolicy(req: BunRequest<'/:bucket'>): Response {
	const bucket = req.params.bucket
	assertBucketExists(bucket)

	const policy = buckets.getPolicy(bucket)
	if (policy === null) {
		throw new S3Error('NoSuchBucketPolicy', 404, 'The bucket policy does not exist.', `/${bucket}`)
	}
	return new Response(policy, { headers: { 'Content-Type': 'application/json' } })
}

export function deleteBucketPolicy(req: BunRequest<'/:bucket'>): Response {
	const bucket = req.params.bucket
	assertBucketExists(bucket)

	buckets.setPolicy(bucket, null)
	return new Response(null, { status: 204 })
}

// An anonymous GET or HEAD may read an object only when its bucket has a policy. Listing, writes and
// subresources (uploads, uploadId, policy) are never anonymous. Signed requests are never treated as anonymous here:
// they are checked by checkAuth, even when a policy would allow them.
export function isPublicRead(req: BunRequest<'/:bucket/*'>): boolean {
	if (req.method !== 'GET' && req.method !== 'HEAD') return false
	if (isSignedRequest(req)) return false

	const query = new URL(req.url).searchParams
	if (query.has('uploadId') || query.has('uploads') || query.has('policy')) return false
	if (!objectKey(req)) return false

	return buckets.getPolicy(req.params.bucket) !== null
}
