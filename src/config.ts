import { join } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024

export type Config = {
	port: number
	dataDir: string
	sqlitePath: string
	maxFileBytes: number
	logDir: string
	accessKeyId: string
	secretAccessKey: string
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
	const port = Number(env.PORT || 3000)
	const dataDir = env.DATA_DIR || './data'
	const maxFileBytes = Number(env.MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES)

	if (!Number.isInteger(port) || port < 0) {
		throw new Error(`PORT must be a non-negative integer, got "${env.PORT}"`)
	}
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
		throw new Error(`MAX_FILE_BYTES must be a positive integer, got "${env.MAX_FILE_BYTES}"`)
	}
	if (!env.ACCESS_KEY_ID || !env.SECRET_ACCESS_KEY) {
		throw new Error('ACCESS_KEY_ID and SECRET_ACCESS_KEY must be set')
	}

	return {
		port,
		dataDir,
		sqlitePath: env.SQLITE_DB || join(dataDir, 'storage.db'),
		maxFileBytes,
		logDir: env.LOG_DIR || './logs',
		accessKeyId: env.ACCESS_KEY_ID,
		secretAccessKey: env.SECRET_ACCESS_KEY,
	}
}

export const config = loadConfig()
