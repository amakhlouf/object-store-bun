import { cpSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { config } from './config'
import { db } from './db'

// Copies the object files and a consistent snapshot of the database into destDir.
// The server can keep running: VACUUM INTO reads the database through SQLite, so the WAL file is not copied raw.
export function backup(destDir: string): void {
	mkdirSync(destDir, { recursive: true })

	const dbPath = resolve(config.sqlitePath)
	db.run('VACUUM INTO ?', [join(destDir, basename(dbPath))])

	// Skip the live database files and unfinished uploads (*.tmp); the snapshot above replaces the database.
	cpSync(resolve(config.dataDir), destDir, {
		recursive: true,
		filter: src => {
			const path = resolve(src)
			return path !== dbPath && !path.startsWith(dbPath + '-') && !path.endsWith('.tmp')
		},
	})
}

if (import.meta.main) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const dest = resolve(Bun.env.BACKUP_DIR ?? join('backups', stamp))
	backup(dest)
	console.log(`backup written to ${dest}`)
}
