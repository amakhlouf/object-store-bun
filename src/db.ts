import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { config } from './config'

mkdirSync(dirname(config.sqlitePath), { recursive: true })

export const db = new Database(config.sqlitePath, { create: true, strict: true })
db.exec('PRAGMA journal_mode = WAL;')
db.exec(`
  CREATE TABLE IF NOT EXISTS buckets (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS objects (
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    content_type TEXT NOT NULL,
    last_modified TEXT NOT NULL,
    PRIMARY KEY (bucket, key)
  );
`)

export type BucketRow = { name: string, created_at: string }

export const buckets = {
	exists(name: string): boolean {
		return db.query('SELECT 1 FROM buckets WHERE name = ?').get(name) !== null
	},

	insert(name: string, createdAt: string): void {
		db.query('INSERT INTO buckets (name, created_at) VALUES (?, ?)').run(name, createdAt)
	},

	remove(name: string): void {
		db.query('DELETE FROM buckets WHERE name = ?').run(name)
	},

	list(): BucketRow[] {
		return db.query<BucketRow, []>('SELECT name, created_at FROM buckets ORDER BY name').all()
	},

	countObjects(name: string): number {
		const row = db
			.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM objects WHERE bucket = ?')
			.get(name)
		return row?.n ?? 0
	},
}

export type ObjectRow = {
	bucket: string
	key: string
	size: number
	etag: string
	content_type: string
	last_modified: string
}

export const objects = {
	get(bucket: string, key: string): ObjectRow | null {
		return db
			.query<ObjectRow, [string, string]>('SELECT * FROM objects WHERE bucket = ? AND key = ?')
			.get(bucket, key)
	},

	upsert(row: ObjectRow): void {
		db.query(
			'INSERT OR REPLACE INTO objects (bucket, key, size, etag, content_type, last_modified) VALUES (?, ?, ?, ?, ?, ?)',
		).run(row.bucket, row.key, row.size, row.etag, row.content_type, row.last_modified)
	},

	remove(bucket: string, key: string): void {
		db.query('DELETE FROM objects WHERE bucket = ? AND key = ?').run(bucket, key)
	},

	// Keys in the bucket that start with prefix and sort after `after`, in key order.
	// Pass '' for after to start from the beginning.
	list(bucket: string, prefix: string, after: string, limit: number): ObjectRow[] {
		return db
			.query<ObjectRow, [string, string, string, string, number]>(
				`SELECT * FROM objects
				WHERE bucket = ? AND key > ? AND substr(key, 1, length(?)) = ?
				ORDER BY key
				LIMIT ?`,
			)
			.all(bucket, after, prefix, prefix, limit)
	},
}
