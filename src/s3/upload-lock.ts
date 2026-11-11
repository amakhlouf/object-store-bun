// A lock for each multipart upload, kept in memory (the server is one process).
//
// Part uploads share it, so parts can be written side by side. Completing, aborting, and expiring an upload take it
// alone, so they never read a part that is half written, never delete files under a running upload, and a second
// Complete never starts while the first is still reading the parts. Requests are served in the order they arrive, so a
// waiting Complete or Abort is not starved by parts that keep arriving behind it.

type Waiter = { exclusive: boolean, start: () => void }
type State = { readers: number, writing: boolean, queue: Waiter[] }

const locks = new Map<string, State>()

// Starts every waiter at the front of the queue that the lock allows.
function admit(state: State): void {
	for (let next = state.queue[0]; next; next = state.queue[0]) {
		if (next.exclusive ? state.readers > 0 || state.writing : state.writing) return
		state.queue.shift()
		if (next.exclusive) state.writing = true
		else state.readers++
		next.start()
		if (next.exclusive) return
	}
}

export async function withUploadLock<T>(uploadId: string, exclusive: boolean, task: () => Promise<T>): Promise<T> {
	let state = locks.get(uploadId)
	if (!state) {
		state = { readers: 0, writing: false, queue: [] }
		locks.set(uploadId, state)
	}
	const held = state

	await new Promise<void>(start => {
		held.queue.push({ exclusive, start })
		admit(held)
	})
	try {
		return await task()
	} finally {
		if (exclusive) held.writing = false
		else held.readers--
		admit(held)
		if (!held.writing && held.readers === 0 && held.queue.length === 0) locks.delete(uploadId)
	}
}
