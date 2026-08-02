# Roadmap: SeaweedFS single-container consolidation (3 → 1)

> Status: decided 2026-08-02 (maintainer) — stay on SeaweedFS and collapse
> `seaweedmaster` / `seaweedvolume` / `s3` into one `weed server` container, in both
> compose files. Evidence: storage-engine evaluation of 2026-08-02 (summary below;
> key sources inline).
>
> Implemented 2026-08-02 in commit 8eab94e5a (compose) — code and docs are done.
> Three verification items need the maintainer's stack and are still open; see
> "What still needs the maintainer's stack" at the end. Do not dissolve this file
> into `docs/` until those are closed.

## Decision & context

A 2026-08-02 evaluation compared staying on SeaweedFS against switching the storage
engine (RustFS, Garage, Versity S3 Gateway; MinIO's community repo was archived
read-only in April 2026). Outcome, all final:

1. **Stay on SeaweedFS.** The app's coupling is thin but not zero —
   `srv/repositories/files.ts` talks pure S3 API (one bucket `cg-media`):
   uploads/reads go to `http://s3.local:8333`, while presigned GETs are signed **by
   the backend** (`S3RequestPresigner`) against `APP_HOSTNAME:8333` and only verify
   because nginx's `/files/` location re-expands the path-embedded signature into
   SigV4 query params and forwards `Host $host:8333`. A swap is *possible* (any
   SigV4-correct store), but every candidate loses on some axis we care about:
   - **RustFS**: rejected. Still pre-GA (`1.0.0-beta.12`), ~28 security advisories
     Dec 2025 – Jul 2026 with no downward trend, documented unreviewed/LLM-reviewed
     merges of auth-relevant code, opaque MinIO-style `xl.meta` on-disk format,
     higher RAM than MinIO. Do not revisit before it has a year of boring GA history.
   - **Garage** (v2.3.0) and **versitygw** (v1.7.0): both credible. Garage is the
     community default for this profile; versitygw stores objects as plain POSIX
     files (best possible backup story) — but either means an S3-level data migration
     across every existing deployment (hosted + all selfhost installs) for no user-visible
     gain. Re-evaluate only if a concrete need appears; until then SeaweedFS is the
     engine of record.
2. **Collapse 3 containers → 1.** Motives: footprint (same spirit as the Phase-5
   Redis 3→1), attack surface (the 2026 SeaweedFS criticals were on the
   unauthenticated filer/volume gRPC planes that today are open to every container on
   the `cryptogram` network), and **backups** — with one `/data` directory a single
   filesystem snapshot is atomic across volume blobs *and* filer metadata, which the
   current two-volume split can never be.
3. Upstream is steering the same way: the official image's default CMD is now the
   all-in-one `weed mini`, and the maintainer names "an S3 gateway that issues
   presigned upload/download URLs" as an appropriate single-node production use
   ([discussion #9259](https://github.com/seaweedfs/seaweedfs/discussions/9259)).

## Prerequisite — DONE in this PR

- [x] Pin `chrislusf/seaweedfs` → `4.40` in both compose files (was untagged =
  `:latest`). Security floor is **4.34**: two criticals fixed in 4.24
  ([GHSA-2v6v-25fm-p4fg](https://github.com/seaweedfs/seaweedfs/security/advisories/GHSA-2v6v-25fm-p4fg)
  unauthenticated filer IAM gRPC,
  [GHSA-87fv-vqqr-m4jr](https://github.com/seaweedfs/seaweedfs/security/advisories/GHSA-87fv-vqqr-m4jr)
  volume-server SSRF), cross-bucket read via `X-Amz-Copy-Source`
  (CVE-2026-55874) fixed in 4.34. The hosted Swarm stack pins independently in the
  separate infrastructure repository — carry the pin there too.

## Target picture

- One service `seaweed` (network alias **`s3.local`** stays) per compose file,
  replacing the three current services:

  ```
  weed server -dir=/data -ip=seaweed \
    -master.volumeSizeLimitMB=<n> -volume.max=0 -volume.preStopSeconds=1 \
    -s3 -s3.config=/etc/seaweedfs/s3.json -s3.port=8333 -s3.port.iceberg=0
  ```

  (`-s3.port.iceberg=0` was added at implementation time — see "code won" note 1.)

  `-s3` implies `-filer`. Keep `WEED_MASTER_VOLUME_GROWTH_COPY_1=1` / `..._OTHER=1`.
  `<n>` = `16` (dev) / `${SEAWEED_VOLUME_LIMIT_MB:-1024}` (selfhost), same values as
  today's `master -volumeSizeLimitMB`.
- **`weed server`, not `weed mini`**, deliberately: stable flag surface and no extra
  listeners. `mini` bundles WebDAV, Admin UI and an Iceberg REST catalog, enables an
  embedded IAM API on the S3 port by default, and upstream reserves the right to
  evolve its defaults between releases.
- Backend and nginx are **untouched**: endpoint `http://s3.local:8333`, same
  `s3.json` credentials, same presigning.
- One named volume **`seaweedfs-data`** replaces `seaweedfs-volume` +
  `seaweedfs-buckets`.

## Data migration (derived from upstream source, not docs — test on a copy)

The collapsed process expects exactly the union of the two current volumes: volume
files (`.dat`/`.idx`/`.vif`) at the `/data` root, filer leveldb at
`/data/filerldb2` (`weed server` wires the filer's default store dir to `-dir`;
verified in `weed/command/server.go`). Master raft/sequence state is currently
*ephemeral* anyway (nothing is mounted at the master's `-mdir`) and rebuilds from
volume heartbeats; after the collapse it persists under `/data` for free.

1. Stop the stack.
2. Create `seaweedfs-data`; copy `seaweedfs-volume/*` → its root and
   `seaweedfs-buckets/filerldb2/` → `filerldb2/`.
3. Start; `--remove-orphans` retires the three old containers. Both wrappers now
   pass it: `selfhost.sh` since Phase 5, and `run.sh up`/`down` as of this PR. The
   old volumes stay on disk until the operator deletes them — documented, not
   automated.

Step 2 is implemented as `docker/selfhost/migrate_seaweed_volumes.sh`.

Gotchas:

- Since image 4.00 the container runs as uid 1000 and the entrypoint `chown -R`s
  `/data` on ownership mismatch — a one-time cost proportional to file count that
  looks like a hang on a large store. Mention it in the upgrade note.
- `weed mini` (not our pick) uses a different volume port; irrelevant if we stick
  with `server`, which keeps master 9333 / volume 8080 / filer 8888 / s3 8333.

## Verification items (before this lands)

Verified in a sandbox against the real `chrislusf/seaweedfs:4.40` image, with a
dummy-credential `s3.json` of the same shape as `docker/s3_config/s3.json`, the
exact compose command, and `--hostname seaweed` to mimic compose DNS.

- [x] **Backend presigner half** of the presigned flow: `boto3` configured exactly
  like `files.ts` (region `global`, `forcePathStyle`, bucket `cg-media`) —
  ListBuckets, CreateBucket, PutObject, GetObject round-trip, HeadObject,
  ListObjectsV2, DeleteObject, an anonymous GET via the `Read:cg-media` identity,
  and a **presigned GET fetched with no credentials** all passed (10/10) straight
  against `:8333`. No `SignatureDoesNotMatch`, so `-s3.externalUrl` was not needed.
- [ ] **nginx `/files/` half** of the presigned flow (the path-embedded signature
  re-expanded into SigV4 query params, `Host $host:8333`) — **NOT verified**: needs
  the full stack with nginx and a real backend, which the sandbox cannot bring up.
  Still needs the maintainer's stack. The backend-presigner result above is good
  evidence but does not cover the rewrite.
- [x] Internal listeners enumerated inside the container: S3 8333, master 9333,
  volume 8080, filer 8888, Iceberg 8181, plus gRPC siblings 18333/19333/18080/18888.
  Nothing but 8333 is consumed by any other service (sweep below). **8181 is now
  disabled** via `-s3.port.iceberg=0`. The rest **cannot** be confined by weed flags
  — see "code won" note 2.
- [ ] Existing-data reuse path against a copy of **real** data — **NOT verified**:
  needs the maintainer's stack. What *was* verified: the merge script against
  synthetic fixtures (correct target layout, recursive copy incl. nested dirs,
  refuses a non-empty target, refuses a missing source), and that a container
  restarted onto an existing populated `/data` keeps its bucket, object and
  presigned GET working.
- [x] `docker/build.sh` / `run.sh` / nginx configs reference no seaweed hostname
  other than `s3.local`. Repo-wide sweep: the only `s3.local` references are
  `srv/repositories/files.ts` (×2), the four nginx configs, and the compose alias.
  After the change, `seaweedmaster` / `seaweedvolume` / `seaweedfs-volume` /
  `seaweedfs-buckets` appear **nowhere outside docs**.

## Implementation findings ("code won")

1. **`weed server -s3` starts an Iceberg REST catalog too.** The Target-picture
   rationale above claims Iceberg is a `mini`-only liability; 4.40 logs
   `Start Iceberg REST Catalog Server at http://seaweed:8181` under plain `server`.
   Since the stated reason for picking `server` was "no extra listeners", the
   compose command adds **`-s3.port.iceberg=0`** (documented as `0 to disable`).
   Verified: 8181 gone, S3 round-trip unaffected. This is the one deviation from
   the command spelled out in Target picture.
2. **The internal planes cannot be hidden with weed flags.** `-ip.bind=127.0.0.1`
   plus `-s3.ip.bind=0.0.0.0` does bind master/volume/filer to loopback and leaves
   S3 reachable — but writes then fail (`PutObject` → `InternalError`), because the
   components still dial each other at the advertised `-ip` address. So master 9333,
   volume 8080, filer 8888 and their gRPC ports stay reachable to every container on
   the `cryptogram` network, exactly as before the consolidation (no regression, no
   improvement). Confining them needs **network-level** segmentation — e.g. a
   separate docker network joined only by nginx/api/job-runner — not a flag. Left
   for the maintainer to decide; noted here rather than in `docs/` on purpose.
3. **`depends_on` count: two lists per compose file, not four** (`api` and
   `job-runner` in each). The Verification-items text said "four lists per file";
   four is the total across both files.
4. **`-volume.max=0` is a real behavior change, not a no-op.** The default cap is 8
   volumes; at the dev `-master.volumeSizeLimitMB=16` that would have capped the dev
   store at 128 MB. Auto-sizing from free disk space is the intended behavior.
5. **Predicted `/data` layout confirmed exactly**: blobs (`.dat`/`.idx`/`.vif`) at
   the root, filer leveldb in `filerldb2/`, and master state in `m9333/` — the last
   of which is the "persists under `/data` for free" the Data-migration section
   predicted. `vol_dir.uuid` also appears at the root.

## Checklist

- [x] Dev compose: 3 services → 1 + volume swap
- [x] Selfhost compose: same; `SEAWEED_VOLUME_LIMIT_MB` semantics kept
  (`-master.volumeSizeLimitMB=${SEAWEED_VOLUME_LIMIT_MB:-1024}`, override verified
  via `docker compose config`)
- [x] Migration procedure in `docker/SELFHOST.md` (chown note, old-volume cleanup,
  `SEAWEED_VOLUME_LIMIT_MB` unchanged). **Decision: it stays a documented manual
  step**, not part of `selfhost.sh update` — the merge is only safe with the stack
  stopped, whereas `update` is a pull/rebuild/restart cycle. Implemented as
  `docker/selfhost/migrate_seaweed_volumes.sh`, which copies rather than moves and
  refuses a non-empty target.
- [x] `run.sh up`/`down` now pass `--remove-orphans` so the dev stack retires the
  three old containers
- [x] Docs in the same PR: `docs/architecture` (topology diagram + service table +
  selfhost paragraph), `docs/infrastructure` (service section + volume table +
  depends_on + selfhost volume list), `docs/deployment` (service table + volume
  enumerations + backup section)
- [x] **Backup guidance**: stop → snapshot → start documented as the blessed
  baseline in both `docs/deployment` §3.7 and `docker/SELFHOST.md`, including why
  one volume makes the snapshot atomic and that upstream has no online-consistent
  backup. `weed filer.backup` and bucket versioning named as the second tier.
- [ ] Hosted Swarm: the infra repo must pin the same image, and may mirror the
  collapse. Recorded in `docs/todo/TODO.md`; **nothing in this repo can perform or
  verify it**. Note the roadmap's original "before or with the image rollout"
  framing was too strong for the *topology* half: the app only talks to
  `s3.local:8333`, so the Swarm stack can stay three-service as long as it pins the
  image. The pin is the urgent part.

## What still needs the maintainer's stack

1. The nginx `/files/` presigned rewrite against the collapsed container.
2. The volume merge against a copy of real production/selfhost data, including the
   first-start `chown -R /data` on a large store.
3. A full `./run.sh up` cycle confirming `--remove-orphans` actually retires the
   three old dev containers and that the app serves uploads end-to-end.

## Rules

- Same PR discipline as the slimming phases: one reviewable PR against `develop`,
  docs updated in the same PR, this file is dissolved into the affected `docs/`
  sections when the workstream finishes.
