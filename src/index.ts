import { config } from './config'
import { checkAuth } from './s3/auth'
import { createBucket, deleteBucket, headBucket, listBuckets } from './s3/buckets'
import { health } from './health'
import { errorToResponse } from './s3/errors'
import { deleteObject, getObject, headObject, listObjects, putObject } from './s3/objects'

// Every routed handler checks the request signature before it runs.
function authed<R extends Request>(handler: (req: R) => Response | Promise<Response>) {
	return (req: R) => {
		checkAuth(req)
		return handler(req)
	}
}

export const server = Bun.serve({
	port: config.port,
	routes: {
		'/health': {
			GET: health,
		},
		'/': {
			GET: authed(listBuckets),
		},
		'/:bucket': {
			GET: authed(listObjects),
			PUT: authed(createBucket),
			HEAD: authed(headBucket),
			DELETE: authed(deleteBucket),
		},
		'/:bucket/*': {
			GET: authed(getObject),
			HEAD: authed(headObject),
			PUT: authed(putObject),
			DELETE: authed(deleteObject),
		},
	},
	fetch: () => new Response('Not Implemented', { status: 501 }),
	error: errorToResponse,
})

console.log(`S3 storage listening on ${server.url}`)
