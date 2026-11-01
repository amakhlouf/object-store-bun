import { log } from '../log'
import { xmlResponse } from './responses'

export class S3Error extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly resource = '',
	) {
		super(message)
	}
}

export function errorToResponse(error: unknown): Response {
	let s3: S3Error

	if (error instanceof S3Error) {
		s3 = error
	} else {
		log(`ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
		s3 = new S3Error('InternalError', 500, 'We encountered an internal error. Please try again.')
	}

	return xmlResponse(
		{
			Error: {
				Code: s3.code,
				Message: s3.message,
				Resource: s3.resource,
				RequestId: crypto.randomUUID(),
			},
		},
		s3.status,
	)
}
