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
  CREATE TABLE IF NOT EXISTS multipart_uploads (
    upload_id TEXT PRIMARY KEY,
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS multipart_parts (
    upload_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    PRIMARY KEY (upload_id, part_number)
  );
`)

export type UploadRow = { upload_id: string, bucket: string, key: string, content_type: string, created_at: string }
export type PartRow = { upload_id: string, part_number: number, size: number, etag: string }

// Multipart uploads in progress. The part bytes live under config.uploadsDir; these rows say which parts exist.
export const uploads = {
	get(uploadId: string): UploadRow | null {
		return db.query<UploadRow, [string]>('SELECT * FROM multipart_uploads WHERE upload_id = ?').get(uploadId)
	},

	create(row: UploadRow): void {
		db.query(
			'INSERT INTO multipart_uploads (upload_id, bucket, key, content_type, created_at) VALUES (?, ?, ?, ?, ?)',
		).run(row.upload_id, row.bucket, row.key, row.content_type, row.created_at)
	},

	// Uploading a part number again replaces the earlier part.
	putPart(row: PartRow): void {
		db.query(
			'INSERT OR REPLACE INTO multipart_parts (upload_id, part_number, size, etag) VALUES (?, ?, ?, ?)',
		).run(row.upload_id, row.part_number, row.size, row.etag)
	},

	parts(uploadId: string): PartRow[] {
		return db
			.query<PartRow, [string]>('SELECT * FROM multipart_parts WHERE upload_id = ? ORDER BY part_number')
			.all(uploadId)
	},

	// Parts numbered above afterPart, in part number order.
	partsAfter(uploadId: string, afterPart: number, limit: number): PartRow[] {
		return db
			.query<PartRow, [string, number, number]>(
				'SELECT * FROM multipart_parts WHERE upload_id = ? AND part_number > ? ORDER BY part_number LIMIT ?',
			)
			.all(uploadId, afterPart, limit)
	},

	// Uploads in a bucket whose key starts with prefix, ordered by key, then start time. They come after the marker:
	// a later key, or the same key and a later upload when `after` is given.
	list(
		bucket: string,
		prefix: string,
		afterKey: string,
		after: { created_at: string, upload_id: string } | undefined,
		limit: number,
	): UploadRow[] {
		const sameKeyLater = after
			? 'OR (key = ? AND (created_at > ? OR (created_at = ? AND upload_id > ?)))'
			: ''
		const sameKeyArgs = after ? [afterKey, after.created_at, after.created_at, after.upload_id] : []
		return db
			.query<UploadRow, (string | number)[]>(
				`SELECT * FROM multipart_uploads
				 WHERE bucket = ? AND substr(key, 1, length(?)) = ? AND (key > ? ${sameKeyLater})
				 ORDER BY key, created_at, upload_id LIMIT ?`,
			)
			.all(bucket, prefix, prefix, afterKey, ...sameKeyArgs, limit)
	},

	// Uploads started before cutoff (an ISO time), for the expiry sweep.
	startedBefore(cutoff: string): UploadRow[] {
		return db.query<UploadRow, [string]>('SELECT * FROM multipart_uploads WHERE created_at < ?').all(cutoff)
	},

	remove(uploadId: string): void {
		db.transaction(() => {
			db.query('DELETE FROM multipart_parts WHERE upload_id = ?').run(uploadId)
			db.query('DELETE FROM multipart_uploads WHERE upload_id = ?').run(uploadId)
		})()
	},
}

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
