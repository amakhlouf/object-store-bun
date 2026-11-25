import { join } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS = 7

// The Docker image keeps its volumes here. It sets IN_CONTAINER=1, which pins both folders, so a DATA_DIR or
// BACKUP_DIR from a shared .env can't send data outside the volumes. Natively they are read from the environment.
// The marker is checked here, not on the command line, so the backup command (a separate process) is pinned too.
const CONTAINER_DATA_DIR = '/data'
const CONTAINER_BACKUP_DIR = '/backups'

// Same order as .env.example: keys, server settings, then folders.
export type Config = {
	accessKeyId: string
	secretAccessKey: string
	port: number
	maxFileBytes: number
	// Multipart uploads older than this many days are aborted. 0 keeps them until they are completed or aborted.
	incompleteUploadExpireAfterDays: number
	dataDir: string
	bucketsDir: string
	uploadsDir: string
	logDir: string
	backupDir: string
	sqlitePath: string
}

// Reads --port=3000 or --port 3000 from the command line. The Dockerfile starts the server with it, so the
// container always listens on 3000 whatever PORT says, the way a Postgres image always starts on 5432.
function portFromArgs(argv: string[]): string | undefined {
	const i = argv.findIndex(arg => arg === '--port' || arg.startsWith('--port='))
	if (i === -1) return undefined
	return argv[i]!.startsWith('--port=') ? argv[i]!.slice('--port='.length) : argv[i + 1]
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env, argv: string[] = Bun.argv.slice(2)): Config {
	// The flag wins over PORT, and PORT wins over the default.
	const rawPort = portFromArgs(argv) ?? env.PORT
	const port = Number(rawPort || 3000)
	const maxFileBytes = Number(env.MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES)
	const incompleteUploadExpireAfterDays = Number(env.INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS || DEFAULT_INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS)
	const inContainer = env.IN_CONTAINER === '1'
	const dataDir = inContainer ? CONTAINER_DATA_DIR : env.DATA_DIR || './data'

	if (!env.ACCESS_KEY_ID || !env.SECRET_ACCESS_KEY) {
		throw new Error('ACCESS_KEY_ID and SECRET_ACCESS_KEY must be set')
	}
	if (!Number.isInteger(port) || port < 0) {
		throw new Error(`PORT must be a non-negative integer, got "${rawPort}"`)
	}
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
		throw new Error(`MAX_FILE_BYTES must be a positive integer, got "${env.MAX_FILE_BYTES}"`)
	}
	if (!Number.isFinite(incompleteUploadExpireAfterDays) || incompleteUploadExpireAfterDays < 0) {
		throw new Error(`INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS must be zero or a positive number, got "${env.INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS}"`)
	}

	return {
		accessKeyId: env.ACCESS_KEY_ID,
		secretAccessKey: env.SECRET_ACCESS_KEY,
		port,
		maxFileBytes,
		incompleteUploadExpireAfterDays,
		dataDir,
		bucketsDir: join(dataDir, 'buckets'),
		// Parts of unfinished multipart uploads. Not inside buckets/, so no bucket name can collide with it.
		uploadsDir: join(dataDir, 'uploads'),
		logDir: join(dataDir, 'logs'),
		// Outside DATA_DIR by default, so a backup is never copied into itself or kept on the same volume as the data.
		backupDir: inContainer ? CONTAINER_BACKUP_DIR : env.BACKUP_DIR || './backups',
		sqlitePath: join(dataDir, 'storage.db'),
	}
}

export const config = loadConfig()
