# Roadmap: SeaweedFS single-container consolidation (3 → 1)

> Status: decided 2026-08-02 (maintainer) — stay on SeaweedFS and collapse
> `seaweedmaster` / `seaweedvolume` / `s3` into one `weed server` container, in both
> compose files. Evidence: storage-engine evaluation of 2026-08-02 (summary below;
> key sources inline).

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
    -master.volumeSizeLimitMB=<n> \
    -s3 -s3.config=/etc/seaweedfs/s3.json -s3.port=8333
  ```

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
3. Start; `--remove-orphans` retires the three old containers. That flag is the
   default only in the **selfhost** wrapper (`selfhost.sh`, since Phase 5) —
   `run.sh` does *not* pass it, so either add it there in the same PR or the dev
   stack keeps the three old containers running. The old volumes stay on disk until
   the operator deletes them — document, don't automate the deletion.

Gotchas:

- Since image 4.00 the container runs as uid 1000 and the entrypoint `chown -R`s
  `/data` on ownership mismatch — a one-time cost proportional to file count that
  looks like a hang on a large store. Mention it in the upgrade note.
- `weed mini` (not our pick) uses a different volume port; irrelevant if we stick
  with `server`, which keeps master 9333 / volume 8080 / filer 8888 / s3 8333.

## Verification items (before this lands)

- [ ] **Presigned flows against a single-container stack with a copy of real data** —
  both the backend presigner (`files.ts`) and the nginx `/files/` SigV4 rewrite
  (region `global`, `Host $host:8333`). Signature verification behind reverse
  proxies is SeaweedFS's recurring failure mode (a steady stream of
  `SignatureDoesNotMatch` fixes through 2026); if it bites, `-s3.externalUrl` is the
  documented knob. Today's setup works with the same filer code path, so no change
  is *expected* — verify, don't assume.
- [ ] Which of the internal listeners (master 9333, volume 8080, filer 8888) can be
  disabled or bound so other containers on the network can't reach them; at minimum
  confirm nothing but 8333 is consumed by any other service. The 2026 criticals
  lived exactly on those planes.
- [ ] Existing-data reuse path (step 2 above) against a throwaway copy, including a
  second up/down cycle (idempotence) and an upload + presigned download round-trip.
- [ ] `docker/build.sh` / `run.sh` / nginx configs reference no seaweed hostname
  other than `s3.local` (expected from the Phase-5-style sweep; re-verify at
  implementation time). The compose files themselves DO: unrelated services carry
  `depends_on: seaweedmaster` / `s3` (four lists per file, like the Redis change) —
  retarget them to the new single service.

## Checklist

- [ ] Dev compose: 3 services → 1 + volume swap
- [ ] Selfhost compose: same; keep `SEAWEED_VOLUME_LIMIT_MB` semantics
- [ ] Migration procedure in `docker/SELFHOST.md` (chown note, old-volume cleanup,
  `SEAWEED_VOLUME_LIMIT_MB` unchanged) — decide whether `selfhost.sh update` can
  run the volume merge safely or whether it stays a documented manual step
- [ ] Docs in the same PR: `docs/architecture` (topology diagram + §"three
  containers" mentions), `docs/infrastructure` (service sections + volume table),
  `docs/deployment` (service table + backup/restore section)
- [ ] **Backup guidance** (the point of the exercise): document
  stop → snapshot `/data` → start as the blessed baseline (upstream has no
  online-consistent backup; the maintainer's answer is bucket versioning /
  [wiki Data-Backup](https://github.com/seaweedfs/seaweedfs/wiki/Data-Backup)).
  Optional second tier: `weed filer.backup` replicating content to plain files for
  server-independent restore.
- [ ] Hosted Swarm: the infra repo must replace its three seaweed services with the
  single one **before or with** the image rollout — same coordination pattern as the
  Redis cutover (`docs/deployment` §6, `docs/todo/TODO.md` operational item).

## Rules

- Same PR discipline as the slimming phases: one reviewable PR against `develop`,
  docs updated in the same PR, this file is dissolved into the affected `docs/`
  sections when the workstream finishes.
