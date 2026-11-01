# s3-storage-bun

An S3-compatible object storage server built with Bun. It stores buckets and objects on local disk, with metadata in SQLite.

> **Status: early development.** Intended as a store for form attachments on a private Docker network, used only by a single backend service. Requests are authenticated with one access key pair from `.env`. Chunked uploads aren't supported yet.

## Run

```bash
bun install
bun start        # or: bun dev (restarts on change)
bun check        # typecheck
bun test         # test suite
```

The server prints its address on startup, for example `S3 storage listening on http://localhost:3000/`.

`GET /health` answers without a signature. It returns `{"status":"ok"}` when the database responds, and 503 otherwise.

## Deployment

The setup is one container on a private Docker network, with the backend as its only client:

- The data folder is a named Docker volume, mounted at `/data`.
- The access keys are read from `.env` by compose and passed in as environment variables. They are not copied into the image.
- No ports are published to the host, so only containers on the `attachments` network can reach the server.
- Docker polls `/health`, and the container is marked unhealthy if it stops responding.

```bash
docker compose up -d --build
docker compose ps        # shows the health status
docker compose logs -f storage
```

`compose.yaml` refuses to start unless `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY` are set in `.env`. The Dockerfile sets `PORT`, `DATA_DIR` and `LOG_DIR`. `SQLITE_DB` and `MAX_FILE_BYTES` aren't set there, so the container uses their defaults from `src/config.ts`:

| Setting | In the container |
| ------- | ---------------- |
| `PORT` | `3000` (Dockerfile) |
| `DATA_DIR` | `/data` (the volume, Dockerfile) |
| `SQLITE_DB` | `/data/storage.db` (default from `DATA_DIR`, `src/config.ts`) |
| `MAX_FILE_BYTES` | `10485760` (10 MB, default in `src/config.ts`) |

Your local `.env` may set `DATA_DIR=./data`. Compose doesn't pass that to the container, so the container still uses `/data`.

The image was built and tested on 2026-11-01. The container became healthy, and a signed PUT, GET, and DELETE worked inside it. Logs go to `/data/logs/server.log` in the volume.

## Configuration

Set these in `.env` (Bun loads it automatically):

| Variable          | Default               | Meaning                                              |
| ----------------- | --------------------- | ---------------------------------------------------- |
| `PORT`            | `3000`                | Port to listen on                                    |
| `DATA_DIR`        | `./data`              | Folder for the database, logs, and buckets (`buckets/`) |
| `SQLITE_DB`       | blank (uses `DATA_DIR/storage.db`) | Optional path to the SQLite database. Leave blank to follow `DATA_DIR`. |
| `MAX_FILE_BYTES`  | `10485760` (10 MB)    | Largest object accepted by PutObject                 |
| `BACKUP_DIR`      | `./backups`           | Parent folder for backups. Each run writes a timestamped subfolder. Must be outside `DATA_DIR`; `bun run backup` refuses otherwise. In Docker, compose sets it to `/backups`, a host folder. |
| `LOG_DIR`         | `DATA_DIR/logs`       | Folder for `server.log`. Blank uses the default.     |
| `ACCESS_KEY_ID`   | none (required)       | Public half of the access key pair, sent with requests |
| `SECRET_ACCESS_KEY` | none (required)     | Secret half of the access key pair, never sent       |

## Access keys

Requests must be signed with an access key pair (AWS Signature V4). The pair works like a username and password, with one difference: the secret is never sent. Each request is signed with it instead, and the signature covers that request only.

- **`ACCESS_KEY_ID`:** identifies the key. It's sent in each request's `Authorization` header.
- **`SECRET_ACCESS_KEY`:** signs each request. The server recomputes the signature with its copy and compares.

Create a pair with this command. It prints two lines and writes no files:

```bash
echo "ACCESS_KEY_ID=$(openssl rand -hex 10 | tr 'a-f' 'A-F')"
echo "SECRET_ACCESS_KEY=$(openssl rand -base64 30)"
```

If `openssl` isn't available, use Bun instead:

```bash
bun -e 'const c="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";const r=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>c[b%c.length]).join("");console.log("ACCESS_KEY_ID="+r(20));console.log("SECRET_ACCESS_KEY="+Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("base64"))'
```

Copy both lines into `.env`. Keep the secret out of `.env.example`, chat logs, and commits. `.env` is gitignored.

Generate the pair on your own machine rather than with an online tool, since the secret would be sent to that service.

Development and production can each have their own pair. A client must use the pair its server has.

## Testing

`bun test` runs the suite against a temporary data folder and a random port, so it never touches `./data`. The folder is deleted when the run ends. To keep it for inspection:

```bash
KEEP_TEST_DATA=1 bun test
```

## Logs

Each request writes one line, and each error writes its stack trace:

```
2026-11-01T16:55:02.113Z GET /health 200 0.4ms
```

Lines go to two places:

- **stdout:** what `docker compose logs` shows.
- **`LOG_DIR/server.log`:** kept on disk, so logs survive outside Docker. The default folder is `DATA_DIR/logs`, so `./data/logs` locally.

Query strings and headers are never logged, so signatures stay out of the log.

The log file is not rotated. It grows until you delete or move it.

## Backups

```bash
bun run backup
```

This writes a new folder, `./backups/<time>`, containing:

- `storage.db`, a consistent snapshot of the database. It is taken through SQLite, so it is safe while the server runs.
- The object files, copied from `DATA_DIR`. Unfinished uploads (`*.tmp`) are skipped.

Set `BACKUP_DIR` to change the parent folder. Each run still writes a timestamped subfolder inside it. `backups/` is gitignored.

Backups are not scheduled, and there is no restore command yet. To restore, stop the server, then copy the backup's files back into `DATA_DIR`.

Keep backups on a different disk from the data. A backup in the same folder is lost with the data.

In Docker, backups go to `./backups` on the host, through a bind mount in `compose.yaml`. Create that folder before `docker compose up`, and make sure the container's `bun` user can write to it. Run a backup with:

```bash
docker compose exec storage bun run backup
```

## Layout

```
src/
  index.ts          routes, auth wrapper, request logging, and server start
  config.ts         reads .env into typed settings and default paths
  db.ts             SQLite schema and queries (buckets, objects)
  storage.ts        object files on disk (written to a temp file, then renamed)
  log.ts            writes lines to stdout and LOG_DIR/server.log
  health.ts         GET /health
  backup.ts         bun run backup
  s3/
    auth.ts         SigV4 signature check (headers and presigned URLs)
    buckets.ts      bucket handlers
    objects.ts      object handlers, including ListObjectsV2 and CopyObject
    errors.ts       S3Error and XML error responses
    responses.ts    XML and JSON response builders
test/
  setup.ts          test environment (temp data folder, random port, test keys)
  s3.test.ts        bucket, object, listing, and auth tests
```

Data on disk:

```
data/
  storage.db        SQLite index
  logs/server.log   request and error log
  buckets/
    photos/         one folder per bucket, created on first object write
      2026/a.jpg    object key "2026/a.jpg"
```

Backups are written outside `data/`, to `BACKUP_DIR`.

The database is the index. Listings and existence checks read it. Object bytes are read from disk only on download.

## Supported operations

| Operation          | Route                          | Status      |
| ------------------ | ------------------------------ | ----------- |
| ListBuckets        | `GET /`                        | Done        |
| CreateBucket       | `PUT /:bucket`                 | Done        |
| HeadBucket         | `HEAD /:bucket`                | Done        |
| DeleteBucket       | `DELETE /:bucket`              | Done        |
| ListObjectsV2      | `GET /:bucket`                 | Done        |
| PutObject          | `PUT /:bucket/*`               | Done        |
| GetObject          | `GET /:bucket/*`               | Done        |
| HeadObject         | `HEAD /:bucket/*`              | Done        |
| DeleteObject       | `DELETE /:bucket/*`            | Done        |
| CopyObject         | `PUT /:bucket/*` + copy header | Done        |
| Multipart upload   | `POST /:bucket/*`              | Not yet     |

Every route requires a valid signature. Errors use the S3 XML error format, with codes such as `AccessDenied`, `SignatureDoesNotMatch`, `NoSuchBucket`, `NoSuchKey`, `BucketNotEmpty`, and `EntityTooLarge`.

## Limits

- **Presigned URLs:** supported. A link works until its `X-Amz-Expires` time, up to 7 days. Its signature covers `UNSIGNED-PAYLOAD`.
- **Range requests:** supported. A `Range` header returns 206 with the requested bytes.
- **Chunked uploads:** SDKs that sign each chunk (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`) are rejected with `NotImplemented`.
- **Payload hash:** a header-signed upload that sends a real SHA-256 hash in `x-amz-content-sha256` is checked against the body. A mismatch returns `XAmzContentSHA256Mismatch` and nothing is stored. Uploads that sign `UNSIGNED-PAYLOAD` are not checked.
- **Single owner:** one access key owns every bucket.

## Before production

Blocking:

1. **Real client test:** upload, download, and delete an attachment through the .NET client. Its signing has not been tested against this server.
2. **Durability:** flush writes to disk before reporting success. A power cut right after an upload can lose data.
3. **Restore:** write a restore procedure and test it.
4. **Scheduled backups:** `bun run backup` only runs by hand.
5. **Backup consistency:** the database snapshot and the file copy are taken at different times, so a delete in between can leave a row with no file.

Not blocking:

- **CopyObject metadata:** the copy always keeps the source content type. The `REPLACE` directive isn't supported. Not needed yet.
- **Multipart upload:** needed only if the client uploads large files this way.
- **Keys:** one shared key pair, with no rotation and no per-client keys.
- **Rate limits:** none.
- **Retention:** backups and log files are never deleted.
- **Log rotation:** `server.log` grows without limit.
- **TLS:** the traffic stays inside the Docker network. Enable it if more of the network can reach the store.

## Decisions

- **Path-style URLs only:** `http://host:PORT/bucket/key`. Virtual-host style isn't supported.
- **Single owner:** one access key will own every bucket. Multi-user keys would live in an `access_keys` table.
- **Metadata in SQLite:** listings and checks never walk the disk.
