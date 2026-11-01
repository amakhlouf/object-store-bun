import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'

// Each line goes to stdout (what Docker captures) and to LOG_DIR/server.log (what survives outside Docker).
const logFile = join(config.logDir, 'server.log')
mkdirSync(config.logDir, { recursive: true })

export function log(line: string): void {
	console.log(line)
	appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}
