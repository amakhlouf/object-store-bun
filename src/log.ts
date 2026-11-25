import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'

// Each line goes to stdout (what Docker captures) and to DATA_DIR/logs/server.log (what survives outside Docker).
const logFile = join(config.logDir, 'server.log')
mkdirSync(config.logDir, { recursive: true })

let warnedLogFailure = false

// A full disk or a bad log folder must not fail requests, so a failed file write only costs the file line.
export function log(line: string): void {
	console.log(line)
	try {
		appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
	} catch (error) {
		if (!warnedLogFailure) {
			warnedLogFailure = true
			console.error(`log file write failed, lines only go to stdout: ${error}`)
		}
	}
}
