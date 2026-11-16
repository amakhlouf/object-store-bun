import type { BunRequest } from 'bun'
import { config } from './config'
import { health } from './health'
import { log } from './log'
import { checkAuth } from './s3/auth'
import { isPublicRead } from './s3/bucket-policy'
import { createBucket, deleteBucket, headBucket, listBuckets } from './s3/buckets'
import { errorToResponse } from './s3/errors'
import { postObject, startUploadSweeper } from './s3/multipart'
import { deleteObject, getObject, headObject, listObjects, putObject } from './s3/objects'

// Every routed handler checks the request signature before it runs.
function authed<R extends Request>(handler: (req: R) => Response | Promise<Response>) {
	return (req: R) => {
		checkAuth(req)
		return handler(req)
	}
}

// Object reads (GET and HEAD) skip the signature only when the bucket's policy allows anonymous reads.
// Every other request, and every signed one, is checked as usual.
function objectReadAuthed(handler: (req: BunRequest<'/:bucket/*'>) => Response | Promise<Response>) {
	return (req: BunRequest<'/:bucket/*'>) => {
		if (!isPublicRead(req)) checkAuth(req)
		return handler(req)
	}
}

// Logs one line per request: method, path, status, and time. The query string and headers are left out,
// so signatures never reach the log. Errors are turned into responses here, so their status can be logged.
function logged<R extends Request>(handler: (req: R) => Response | Promise<Response>) {
	return async (req: R) => {
		const started = performance.now()
		let res: Response
		try {
			res = await handler(req)
		} catch (error) {
			res = errorToResponse(error)
		}
		const path = new URL(req.url).pathname
		log(`${req.method} ${path} ${res.status} ${(performance.now() - started).toFixed(1)}ms`)
		return res
	}
}

export const server = Bun.serve({
	port: config.port,
	routes: {
		'/health': {
			GET: logged(health),
		},
		'/': {
			GET: logged(authed(listBuckets)),
		},
		'/:bucket': {
			GET: logged(authed(listObjects)),
			PUT: logged(authed(createBucket)),
			HEAD: logged(authed(headBucket)),
			DELETE: logged(authed(deleteBucket)),
		},
		'/:bucket/*': {
			GET: logged(objectReadAuthed(getObject)),
			HEAD: logged(objectReadAuthed(headObject)),
			PUT: logged(authed(putObject)),
			POST: logged(authed(postObject)),
			DELETE: logged(authed(deleteObject)),
		},
	},
	fetch: () => new Response('Not Implemented', { status: 501 }),
	error: errorToResponse,
})

startUploadSweeper()

console.log(`S3 storage listening on ${server.url}`)
