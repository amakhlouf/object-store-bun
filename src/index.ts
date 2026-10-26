import { config } from './config'

const server = Bun.serve({
	port: config.port,
	fetch: () => new Response('Not Implemented', { status: 501 }),
})

console.log(`S3 storage listening on ${server.url}`)
