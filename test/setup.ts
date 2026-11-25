import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point every test run at a throwaway data folder and a random port.
// Set before any src module loads, since config.ts reads the environment on import.
const dataDir = mkdtempSync(join(tmpdir(), 'object-store-test-'))
if (!dataDir.startsWith(tmpdir())) throw new Error('Test data dir must be under the OS temp dir')
Bun.env.DATA_DIR = dataDir
Bun.env.PORT = '0'
Bun.env.ACCESS_KEY_ID = 'AKTEST00000000000001'
Bun.env.SECRET_ACCESS_KEY = 'testsecret0000000000000000000000000000'

Bun.env.TEST_DATA_DIR = dataDir
