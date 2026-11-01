import { db } from './db'

// Answers without a signature, so Docker or a load balancer can probe it.
// The SQLite query confirms the database is reachable, not just that the process is up.
export function health(): Response {
	try {
		db.query('SELECT 1').get()
		return Response.json({ status: 'ok' })
	} catch {
		return Response.json({ status: 'error' }, { status: 503 })
	}
}
