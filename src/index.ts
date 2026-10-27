import { config } from './config'
import { createBucket, deleteBucket, headBucket, listBuckets } from './s3/buckets'
import { errorToResponse } from './s3/errors'
import { deleteObject, getObject, headObject, listObjects, putObject } from './s3/objects'

const server = Bun.serve({
	port: config.port,
	routes: {
		'/': {
			GET: listBuckets,
		},
		'/:bucket': {
			GET: listObjects,
			PUT: createBucket,
			HEAD: headBucket,
			DELETE: deleteBucket,
		},
		'/:bucket/*': {
			GET: getObject,
			HEAD: headObject,
			PUT: putObject,
			DELETE: deleteObject,
		},
	},
	fetch: () => new Response('Not Implemented', { status: 501 }),
	error: errorToResponse,
})

console.log(`S3 storage listening on ${server.url}`)
