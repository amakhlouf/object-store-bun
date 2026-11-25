# object-store-bun

An S3-compatible object storage server built with Bun. It stores buckets and objects on local disk, with metadata in SQLite.

> **Status: early development.** Intended as a store for files on a private Docker network, used only by a single backend service. Requests are authenticated with one access key pair from `.env`. It has been tested against the AWS SDKs for .NET and JavaScript.

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

The same code runs four ways. Only how it is started and how clients reach it differ.

| | Native / dev | Docker image | Docker Compose | Dokploy |
| --- | --- | --- | --- | --- |
| Started with | `bun start` | `docker run` | `docker compose up` | An Application built from the `Dockerfile` |
| Port | `PORT` (default 3000) | 3000 inside, fixed | 3000 inside, fixed | 3000 inside, fixed |
| Reached from outside by | `localhost:PORT` | `-p 8080:3000` | `ports:` in `compose.yaml`, or other containers on the same network | A domain, or other apps on a shared network |
| Data and backups | `DATA_DIR` and `BACKUP_DIR` | Mounts you pass at `/data` and `/backups` | Named volumes `storage-data` and `storage-backups` by default | Mounts you add in the UI. **Bind mounts recommended** |
| Settings come from | `.env` | `-e` flags | `.env` and `compose.yaml` | The app's environment in the UI |

In a container, the image fixes the port (3000) and the data and backup folders (`/data` and `/backups`). `PORT`, `DATA_DIR` and `BACKUP_DIR` are ignored there, even with `--env-file .env`. The image starts the server with `--port=3000` and sets `IN_CONTAINER=1`, which pins the two folders. Natively, those three settings work as described under Configuration.

The container never contains the access keys. They are always passed in when it starts, and the server won't start without them.

### Data and backups: use bind mounts

> **Recommended for production and stage: bind mounts.** Mount real folders on the server at `/data` and `/backups`, and keep the backups folder on a different disk from the data.

Why: the files are plain folders you can see, copy and snapshot with ordinary tools; they survive `docker compose down -v` and `docker volume prune`; and `/backups` can sit on another disk. A named volume always lives under Docker's own directory, on the same disk as everything else.

Set the folders up once, before the first start:

```bash
sudo mkdir -p /srv/object-store/data /srv/object-store/backups
sudo chown 1000:1000 /srv/object-store/data /srv/object-store/backups
```

The container runs as the `bun` user, which is UID 1000 in the image (checked with `docker run --rm --entrypoint id object-store-bun bun`). It can only write to folders it owns. Then mount them:

| Deployment | How |
| --- | --- |
| `docker run` | `-v /srv/object-store/data:/data -v /srv/object-store/backups:/backups` |
| Compose | Change the left side of the two volume lines in `compose.yaml` to those paths |
| Dokploy | Mounts dialog, **Bind Mount**: Host Path `/srv/object-store/data`, Mount Path `/data`. Repeat for `/backups` |

Things to know:
- **Create the folders first.** On a Linux server, Docker creates a missing host folder owned by root, which the `bun` user can't write to. The server then exits at startup with a database error. Create the folders and set the owner yourself, as above.
- **A read-only or wrong-owner folder fails the same way.** The container exits with code 1 and the error points at opening the database.
- **Named volumes still work** and need no setup, so they stay the default in `compose.yaml` for local use. Use bind mounts for anything you want to keep.
- On Dokploy, bind mounts only suit a single server. With several nodes, the path would have to exist on every node.

### Native and dev

```bash
cp .env.example .env     # then fill in the keys
bun install
bun start                # or: bun dev
```

Change the port with `PORT` in `.env`, or for one run: `PORT=4000 bun src/index.ts`. Data goes to `./data` and backups to `./backups`, unless `DATA_DIR` and `BACKUP_DIR` say otherwise.

### Docker image

```bash
docker build -t object-store-bun .
docker run -d --name storage \
  -e ACCESS_KEY_ID=... -e SECRET_ACCESS_KEY=... \
  -v storage-data:/data -v storage-backups:/backups \
  -p 8080:3000 \
  object-store-bun
```

- Always mount both folders. The example uses named volumes, which need no setup. For production, use bind mounts as described above. Without any mount, the `VOLUME` lines in the Dockerfile create anonymous volumes, which are easy to lose track of.
- Leave out `-p` to keep the server reachable only from other containers on the same Docker network.
- `MAX_FILE_BYTES` and `INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS` are optional. Pass them with `-e`, or leave them out to use the defaults.
- A plain `docker run` doesn't create a network. To let other containers reach it, create one with `docker network create` and start each container with `--network`.

### Docker Compose

```bash
docker compose up -d --build
docker compose ps        # shows the health status
docker compose logs -f storage
```

- `compose.yaml` refuses to start unless `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY` are set, in `.env` or the shell.
- It mounts two named volumes: `storage-data` at `/data` and `storage-backups` at `/backups`.
- It defines no network of its own, so other services in the same compose file reach it at `http://storage:3000` over the default network. Services in other compose projects need a shared external network.
- No ports are published. To reach it from the host, add `ports: - "8080:3000"` to the `storage` service.
- It passes the two keys, plus `MAX_FILE_BYTES` and `INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS` when they are set in `.env` or the shell. If they are unset, the app's defaults apply.

### Dokploy

Deploy it as an Application built from the `Dockerfile`. In that case `compose.yaml` is not used. These steps come from Dokploy's docs and UI, and haven't been tried on a real Dokploy server.

1. **Environment:** set `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY`. `MAX_FILE_BYTES` and `INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS` are optional.
2. **Mounts (use bind mounts):** create the two folders on the server and set their owner, as described under Data and backups. Then add a **Bind Mount** with Host Path `/srv/object-store/data` and Mount Path `/data`, and another for `/backups`. Do this before the first deploy, so the data never sits in an anonymous volume. A Volume Mount (`storage-data` and `storage-backups`) also works, but it is not recommended for production.
3. **Network:** attach one shared network to this app and to the apps that use it (Advanced, then Networks). The other apps reach it at `http://<app name>:3000`, where the app name is the one shown on its General tab.
4. **Domain:** only if people outside the server need to read objects. Point it at container port 3000.
5. **Replicas:** keep it at one. The database is a single SQLite file on one volume.

The server only serves anonymous reads of objects in a bucket that has a public read policy. Everything else, including listings and writes, needs a signed request. A domain that has to be limited to a private network must be restricted outside this app.

### Logs and backups in a container

Logs go to stdout and to `/data/logs/server.log` in the data volume. To take a backup from a running container:

```bash
docker compose exec storage bun run backup     # Compose
docker exec storage bun run backup             # docker run
```

See Backups for what is copied and how to get the files out of the volume.

The image was built and run on 2026-11-25 with Docker Desktop. Checked: the server was healthy on port 3000 even with `PORT=5000` set; `DATA_DIR` and `BACKUP_DIR` were ignored; with bind mounts, `storage.db` and the logs landed in the data folder and `docker exec ... bun run backup` wrote a backup into the backups folder; and a read-only data folder made the container exit with code 1. Not checked: a signed upload and download in the built image, `docker compose up`, a Docker Engine on a Linux server, and Dokploy.

## Configuration

Set these in `.env` (Bun loads it automatically):

| Variable          | Default               | Meaning                                              |
| ----------------- | --------------------- | ---------------------------------------------------- |
| `PORT`            | `3000`                | Port to listen on when run directly. A `--port=N` flag on the command line wins over it. In Docker the image passes `--port=3000`, so `PORT` has no effect there. |
| `DATA_DIR`        | `./data`              | Folder for the database, logs, buckets (`buckets/`), and multipart parts (`uploads/`) |
| `MAX_FILE_BYTES`  | `20971520` (20 MB)    | Largest object accepted: a PutObject or CopyObject, or a completed multipart upload. Each part is limited to it too. |
| `INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS` | `7`                | Multipart uploads with no activity for this many days are aborted and their parts deleted. Activity is the start of the upload or the newest part written, whichever is later. `0` keeps them until they are completed or aborted. Checked at startup and every hour. |
| `BACKUP_DIR`      | `./backups`           | Parent folder for backups. Each run writes a timestamped subfolder. Must be outside `DATA_DIR`; `bun run backup` refuses otherwise. In Docker the image pins it to `/backups`, a volume separate from the data, and ignores this setting. |
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

The suite covers the S3 operations, signing and the upload body checks, multipart uploads, public buckets, backups, and logging. On 2026-11-11 the server was also run locally and exercised with the real AWS SDK for .NET (AWSSDK.S3 4.0.104.12) and for JavaScript (3.1166): small and large uploads from buffers, streams, and files, multipart uploads including `UploadPartCopy`, `ListParts` and `ListMultipartUploads`, and aborts. That check is not part of `bun test`.

## Logs

Each request writes one line, and each error writes its stack trace:

```
2026-11-01T16:55:02.113Z GET /health 200 0.4ms
```

Lines go to two places:

- **stdout:** what `docker compose logs` shows.
- **`DATA_DIR/logs/server.log`:** kept on disk, so logs survive outside Docker. Locally that's `./data/logs/server.log`.

Query strings and headers are never logged, so signatures stay out of the log.

The log file is not rotated. It grows until you delete or move it.

## Backups

```bash
bun run backup
```

This writes a new folder, `./backups/<time>`, containing:

- `storage.db`, a consistent snapshot of the database. It is taken through SQLite, so it is safe while the server runs.
- The object files, copied from `DATA_DIR`. Files still being written (`tmp/`) and the parts of multipart uploads in progress (`uploads/`) are skipped. Objects are copied whatever their names are, including keys that end in `.tmp`.

Set `BACKUP_DIR` to change the parent folder. Each run still writes a timestamped subfolder inside it. `backups/` is gitignored.

Backups are not scheduled, and there is no restore command yet. To restore, stop the server, then copy the backup's files back into `DATA_DIR`.

Keep backups on a different disk from the data. A backup in the same folder is lost with the data.

In Docker, backups go to `/backups`, a named volume (`storage-backups`) separate from the data volume, so they survive losing the data volume but not the server. Run a backup with:

```bash
docker compose exec storage bun run backup
```

To copy the backups out of the volume, for example to another machine:

```bash
docker compose cp storage:/backups ./backups-copy
```

## Layout

```
src/
  index.ts          routes, auth wrapper, request logging, and server start
  config.ts         reads .env into typed settings and default paths
  db.ts             SQLite schema and queries (buckets, objects, multipart uploads and parts)
  storage.ts        object files on disk (written to a temp file in tmp/, then renamed), and the rules for object keys
  log.ts            writes lines to stdout and DATA_DIR/logs/server.log
  health.ts         GET /health
  backup.ts         bun run backup
  s3/
    auth.ts         SigV4 signature check (headers and presigned URLs); keeps the signing context for chunked uploads
    chunked.ts      aws-chunked body decoder (chunk and trailer signatures, trailing checksums)
    upload-body.ts  the body of an upload and its checks (signature, size, hash), shared by PutObject and UploadPart
    upload-lock.ts  a lock per multipart upload, so Complete, Abort, and expiry never run under a part being written
    key-lock.ts     a lock per object key, so a write and a delete of the same key never interleave
    buckets.ts      bucket handlers
    bucket-policy.ts  bucket policies: the accepted subset, the policy calls, and the anonymous read check
    objects.ts      object handlers, including ListObjectsV2 and CopyObject
    multipart.ts    multipart upload handlers and the cleanup of abandoned uploads
    lookup.ts       helpers shared by the handlers (object key, bucket and object lookups, copy source)
    errors.ts       S3Error and XML error responses
    responses.ts    XML and JSON response builders
test/
  setup.ts          test environment (temp data folder, random port, test keys)
  s3.test.ts        tests for buckets, objects, listing, auth, chunked and multipart uploads, backups, and logging
```

Data on disk:

```
data/
  storage.db        SQLite index
  logs/server.log   request and error log
  uploads/          parts of multipart uploads in progress, one folder per upload
  tmp/              files being written, before they are renamed into place (cleared at start-up)
  buckets/
    photos/         one folder per bucket, created on first object write
      2026/a.jpg    object key "2026/a.jpg"
```

Backups are written outside `data/`, to `BACKUP_DIR`.

The database is the index. Listings and existence checks read it. Object bytes are read from disk only on download.

## Supported operations

| Operation               | Route                                  | Status |
| ----------------------- | -------------------------------------- | ------ |
| ListBuckets             | `GET /`                                | Done   |
| CreateBucket            | `PUT /:bucket`                         | Done   |
| HeadBucket              | `HEAD /:bucket`                        | Done   |
| DeleteBucket            | `DELETE /:bucket`                      | Done   |
| ListObjectsV2           | `GET /:bucket`                         | Done   |
| PutObject               | `PUT /:bucket/*`                       | Done   |
| GetObject               | `GET /:bucket/*`                       | Done   |
| HeadObject              | `HEAD /:bucket/*`                      | Done   |
| DeleteObject            | `DELETE /:bucket/*`                    | Done   |
| CopyObject              | `PUT /:bucket/*` + copy header         | Done   |
| CreateMultipartUpload   | `POST /:bucket/*?uploads`              | Done   |
| UploadPart              | `PUT /:bucket/*?partNumber&uploadId`   | Done   |
| UploadPartCopy          | the same, with a copy header           | Done   |
| CompleteMultipartUpload | `POST /:bucket/*?uploadId`             | Done   |
| AbortMultipartUpload    | `DELETE /:bucket/*?uploadId`           | Done   |
| ListParts               | `GET /:bucket/*?uploadId`              | Done   |
| ListMultipartUploads    | `GET /:bucket?uploads`                 | Done   |
| PutBucketPolicy         | `PUT /:bucket?policy`                  | Done   |
| GetBucketPolicy         | `GET /:bucket?policy`                  | Done   |
| DeleteBucketPolicy      | `DELETE /:bucket?policy`               | Done   |

Bucket requests with a trailing slash (`PUT /bucket/`, which AWS clients send) go to the bucket handlers too. Every route except `GET /health` requires a valid signature, with one exception: an anonymous `GET` or `HEAD` of an object in a bucket with a public-read policy (see Limits). Errors use the S3 XML error format, with codes such as `AccessDenied`, `SignatureDoesNotMatch`, `NoSuchBucket`, `NoSuchKey`, `BucketNotEmpty`, and `EntityTooLarge`.

## Limits

- **Presigned URLs:** supported. A link works until its `X-Amz-Expires` time, up to 7 days. Its signature covers `UNSIGNED-PAYLOAD`.
- **Range requests:** supported. A `Range` header returns 206 with the requested bytes.
- **Public buckets:** a bucket policy (`PutBucketPolicy`, `GetBucketPolicy`, `DeleteBucketPolicy`) can allow anonymous `s3:GetObject` for principal `*` on the bucket's objects. Only that shape is accepted: `Version` `2012-10-17`, `Effect` `Allow`, `Action` `s3:GetObject`, `Resource` `arn:aws:s3:::<bucket>/*`, no `Condition`, at most 20 KB. An anonymous `GET` or `HEAD` of an object reads it when the policy exists, and its response carries `Cache-Control: public, max-age=86400`. That cache time assumes public objects are never overwritten: if a key is overwritten, browsers and proxies can keep serving the old copy for up to a day. Give each new version of a public file a new key. Signed requests are always checked, even on a public bucket. Anonymous listing, writes and multipart requests are refused with `AccessDenied`, as is any anonymous request to a private or missing bucket.
- **Chunked uploads (`aws-chunked`):** supported in three forms: signed chunks (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`), signed chunks with a trailing checksum (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER`, what the .NET SDK sends over HTTP), and unsigned chunks with a trailing checksum (`STREAMING-UNSIGNED-PAYLOAD-TRAILER`). Each chunk signature, the trailer signature, and the trailing checksum (`crc32`, `crc32c`, `sha1`, `sha256`) are checked, and a failure stores nothing. The size limit applies to `x-amz-decoded-content-length`. A `crc64nvme` checksum and the SigV4A streaming type return `NotImplemented`.
- **Multipart uploads:** all the operations above work. As in S3, every part except the last must be at least 5 MiB (completing returns `EntityTooSmall` otherwise), and an upload can have up to 10,000 parts. That minimum does not depend on `MAX_FILE_BYTES`, so with a limit under 5 MiB only a single-part upload fits. `MAX_FILE_BYTES` applies to the finished object and to each part, so raise it for large files. Parts go through the same checks as any upload, and the parts list must be signed too. Parts are kept in `uploads/` until the upload is completed or aborted. An upload with no activity for `INCOMPLETE_UPLOAD_EXPIRE_AFTER_DAYS` (no part written in that time) is aborted, and a part folder that no upload owns (left by a crash) is removed after an hour. Parts of one upload can be written side by side. Complete, Abort, and the expiry wait for parts being written and then run alone, so a second Complete gets `NoSuchUpload`. A PUT with only one of `uploadId` and `partNumber` is rejected with `InvalidArgument`, and a page size of 0 gives an empty page. Backups leave `uploads/` out, so an upload in progress when a backup is restored cannot be completed. ListMultipartUploads orders by key, then start time.
- **Payload hash:** a header-signed upload that sends a real SHA-256 hash in `x-amz-content-sha256` is checked against the body. A mismatch returns `XAmzContentSHA256Mismatch` and nothing is stored. A header-signed upload that signs `UNSIGNED-PAYLOAD` is rejected with `InvalidRequest`, so the body is always covered by the signature. Presigned URLs still use `UNSIGNED-PAYLOAD`, because the link is made before the body exists. Signed chunked uploads are protected by their chunk signatures. The unsigned-trailer form has only its checksum, which catches corruption but not tampering.
- **Single owner:** one access key owns every bucket.

## Differences from AWS S3

This server follows the AWS S3 API, with the differences below. Keep this list up to date, because later changes will be planned against it.

- **Bucket policies (spec `docs/specs/001-public-buckets.md`):** only `PutBucketPolicy`, `GetBucketPolicy` and `DeleteBucketPolicy` are supported. A policy may allow `s3:GetObject` for principal `*` on the bucket's own objects. Other actions, `Deny` statements, conditions and other principals return `NotImplemented`.
- **Anonymous listing:** never allowed, even if a policy asks for it. AWS would allow it with `s3:ListBucket`.
- **Object keys:** a key is stored as a file path, so keys with an empty part (`a//b`, a leading or trailing slash), a `.` or `..` part, or a null character are refused with `InvalidArgument`. A key also can't be both an object and the folder of another key, such as `a` next to `a/b`. AWS allows all of these.
- **Deleting a bucket:** refused with `BucketNotEmpty` while it has objects or multipart uploads in progress.
- **Canned ACLs:** `x-amz-acl` and `PutBucketAcl` are not supported. Object ACLs are not supported either.
- **Block Public Access:** not implemented. Access is controlled only by signatures and the bucket policy.
- **Missing bucket for anonymous requests:** returns `AccessDenied` (403), the same as a private bucket. This is done so bucket names can't be discovered.
- **Access keys:** one key pair owns every bucket. No IAM users, roles, or temporary credentials.
- **Virtual-host URLs:** not supported (path-style only, see Decisions).

## Before production

Blocking:

1. **Durability:** flush writes to disk before reporting success. A power cut right after an upload can lose data.
2. **Restore:** write a restore procedure and test it.
3. **Scheduled backups:** `bun run backup` only runs by hand.
4. **Backup consistency:** the database snapshot and the file copy are taken at different times, so a delete in between can leave a row with no file.

Not blocking:

- **CopyObject metadata:** the copy always keeps the source content type. The `REPLACE` directive isn't supported. Not needed yet.
- **Keys:** one shared key pair, with no rotation and no per-client keys.
- **Rate limits:** none.
- **Retention:** backups and log files are never deleted.
- **Log rotation:** `server.log` grows without limit.
- **TLS:** the traffic stays inside the Docker network. Enable it if more of the network can reach the store.

## Decisions

- **Path-style URLs only:** `http://host:PORT/bucket/key`. Virtual-host style isn't supported.
- **Single owner:** one access key will own every bucket. Multi-user keys would live in an `access_keys` table.
- **Metadata in SQLite:** listings and checks never walk the disk.
