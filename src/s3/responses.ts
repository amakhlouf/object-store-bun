import { XML } from 'bun'

export function xmlResponse(data: object, status = 200): Response {
	const body = XML.stringify(data)
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
		status,
		headers: { 'Content-Type': 'application/xml' },
	})
}
