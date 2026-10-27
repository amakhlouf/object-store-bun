import { config } from './config'
import { createBucket, deleteBucket, headBucket, listBuckets } from './s3/buckets'
import { errorToResponse } from './s3/errors'

const server = Bun.serve({
	port: config.port,
	routes: {
		'/': {
			GET: listBuckets,
		},
		'/:bucket': {
			PUT: createBucket,
			HEAD: headBucket,
			DELETE: deleteBucket,
		},
	},
	fetch: () => new Response('Not Implemented', { status: 501 }),
	error: errorToResponse,
})

console.log(`S3 storage listening on ${server.url}`)
