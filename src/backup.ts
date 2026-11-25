import { cpSync, mkdirSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { config } from './config'
import { db } from './db'

// Copies the object files and a consistent snapshot of the database into destDir.
// The server can keep running: VACUUM INTO reads the database through SQLite, so the WAL file is not copied raw.
export function backup(destDir: string): void {
	const dest = resolve(destDir)
	const data = resolve(config.dataDir)
	// A backup inside DATA_DIR would be copied into itself, and it would sit on the same volume as the data.
	if (dest === data || dest.startsWith(data + sep)) {
		throw new Error(`backup folder ${dest} is inside DATA_DIR ${data}. Set BACKUP_DIR to a folder outside it.`)
	}
	mkdirSync(dest, { recursive: true })

	const dbPath = resolve(config.sqlitePath)
	db.run('VACUUM INTO ?', [join(dest, basename(dbPath))])

	// Skip the live database files, the files being written (tmp/), and the parts of multipart uploads in progress
	// (uploads/). The snapshot above replaces the database. Object files are copied whatever their names are.
	const skipped = [resolve(config.uploadsDir), resolve(config.tmpDir)]
	cpSync(data, dest, {
		recursive: true,
		filter: src => {
			const path = resolve(src)
			if (skipped.some(dir => path === dir || path.startsWith(dir + sep))) return false
			return path !== dbPath && !path.startsWith(dbPath + '-')
		},
	})
}

if (import.meta.main) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const dest = resolve(config.backupDir, stamp)
	backup(dest)
	console.log(`backup written to ${dest}`)
}
