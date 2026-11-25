// A lock for each object key, kept in memory (the server is one process).
//
// A write (PutObject, CopyObject, completing an upload) changes a file and a database row, and so does a delete. Two of
// them on the same key must not interleave: a delete that lands between a write's rename and its database row would
// remove the new file and leave the row. Tasks on one key run one at a time, in the order they arrive. Other keys are
// not affected.

const tails = new Map<string, Promise<void>>()

export async function withKeyLock<T>(bucket: string, key: string, task: () => Promise<T>): Promise<T> {
	const id = `${bucket}\0${key}`
	const previous = tails.get(id) ?? Promise.resolve()
	let release!: () => void
	const mine = new Promise<void>(resolve => {
		release = resolve
	})
	const tail = previous.then(() => mine)
	tails.set(id, tail)

	await previous
	try {
		return await task()
	} finally {
		release()
		// The last task in line removes the entry, so the map doesn't grow with every key ever written.
		if (tails.get(id) === tail) tails.delete(id)
	}
}
