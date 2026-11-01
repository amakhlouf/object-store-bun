import { join } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024

// Same order as .env.example: keys, server settings, then folders.
export type Config = {
	accessKeyId: string
	secretAccessKey: string
	port: number
	maxFileBytes: number
	dataDir: string
	bucketsDir: string
	logDir: string
	backupDir: string
	sqlitePath: string
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
	const port = Number(env.PORT || 3000)
	const maxFileBytes = Number(env.MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES)
	const dataDir = env.DATA_DIR || './data'

	if (!env.ACCESS_KEY_ID || !env.SECRET_ACCESS_KEY) {
		throw new Error('ACCESS_KEY_ID and SECRET_ACCESS_KEY must be set')
	}
	if (!Number.isInteger(port) || port < 0) {
		throw new Error(`PORT must be a non-negative integer, got "${env.PORT}"`)
	}
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
		throw new Error(`MAX_FILE_BYTES must be a positive integer, got "${env.MAX_FILE_BYTES}"`)
	}

	return {
		accessKeyId: env.ACCESS_KEY_ID,
		secretAccessKey: env.SECRET_ACCESS_KEY,
		port,
		maxFileBytes,
		dataDir,
		bucketsDir: join(dataDir, 'buckets'),
		logDir: env.LOG_DIR || join(dataDir, 'logs'),
		// Outside DATA_DIR by default, so a backup is never copied into itself or kept on the same volume as the data.
		backupDir: env.BACKUP_DIR || './backups',
		sqlitePath: env.SQLITE_DB || join(dataDir, 'storage.db'),
	}
}

export const config = loadConfig()
