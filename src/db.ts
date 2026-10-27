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

export type BucketRow = { name: string; created_at: string }

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
