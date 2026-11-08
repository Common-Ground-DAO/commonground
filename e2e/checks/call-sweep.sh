#!/bin/bash
# Call-ending check against the disposable e2e instance (real Postgres,
# Valkey, job-runner, api): the jobs process's call sweeps and their
# `cliCallEvent delete` events, the job-runner startup path, scheduled/event
# calls, restarting an ended event call, the call permission rewrite and the
# monotonic channel read marker (docs/backend/README.md, `callUpdateEmitter.ts`).
#
#   e2e/instance.sh up            # the instance; best after a suite run
#   e2e/checks/call-sweep.sh      # (its data provides a community and a user)
#
# Uses the instance's compose project (E2E_PROJECT, default cg-e2e) only — it
# inserts test rows into its database and restarts its job-runner. Never run
# it against the dev stack or a real instance. Writes its log and the
# Socket.IO emitter traffic it saw to $CHECK_OUT (default
# e2e/results/call-sweep-<timestamp>/). Exit code: 0 all cases passed, 1 a
# case failed, 2 the check could not start.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "$0")/.." && pwd)"
P="${E2E_PROJECT:-cg-e2e}"
if [ "$P" = "docker" ] || [ "$P" = "cg-selfhost" ]; then
  echo "E2E_PROJECT=$P is the dev stack or a real self-host instance; this check only runs against a disposable e2e instance." >&2
  exit 2
fi
for service in db redis api job-runner mediasoup; do
  if [ -z "$(docker ps -q --filter "name=^${P}-${service}-1\$")" ]; then
    echo "container ${P}-${service}-1 is not running — start the instance with e2e/instance.sh up" >&2
    exit 2
  fi
done
OUT="${CHECK_OUT:-$E2E_DIR/results/call-sweep-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
LOG="$OUT/call-sweep.log"
: > "$LOG"
FAILS=0

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }
ok() { log "OK   $*"; }
bad() { log "FAIL $*"; FAILS=$((FAILS + 1)); }
sql() { docker exec -i "$P-db-1" psql -U postgres -d cryptogram -v ON_ERROR_STOP=1 -qAt -c "$1"; }
# runs a script with the backend's compiled repositories (/dist) in the api container
api_node() { docker exec "$P-api-1" node -e "$1" 2>&1 | grep -v '^WARNING' | tail -3; }

# --- fixtures from the instance's data ---------------------------------------
COMMUNITY=$(sql "SELECT c.id FROM communities c WHERE EXISTS (SELECT 1 FROM roles r WHERE r.\"communityId\" = c.id AND r.title = 'Admin') ORDER BY c.\"createdAt\" DESC LIMIT 1")
USER_ID=$(sql "SELECT id FROM users ORDER BY \"createdAt\" DESC LIMIT 1")
LIVE_SERVER=$(sql "SELECT id FROM callservers WHERE \"deletedAt\" IS NULL AND \"updatedAt\" > now() - interval '10 seconds' LIMIT 1")
log "community=$COMMUNITY user=$USER_ID live callserver=$LIVE_SERVER"
if [ -z "$COMMUNITY" ] || [ -z "$USER_ID" ] || [ -z "$LIVE_SERVER" ]; then
  echo "fixtures missing: needs a community and a user (run the suite first) and a running call server" >&2
  exit 2
fi

# a call server whose heartbeat stopped 5 minutes ago (inserted directly, so
# no process ever ran for it — like a call server that was killed)
new_gone_server() {
  sql "INSERT INTO callservers (status, url, \"updatedAt\") VALUES ('{\"ongoingCalls\":1}', 'check-gone-$1-$RANDOM.invalid', now() - interval '5 minutes') RETURNING id" | head -1
}
# new_call <serverId|NULL> <title> [scheduleDate-sql]
new_call() {
  local channel server sched
  channel=$(sql "INSERT INTO channels DEFAULT VALUES RETURNING id" | head -1)
  server="NULL"; [ "$1" != "NULL" ] && server="'$1'"
  sched="${3:-NULL}"
  sql "INSERT INTO calls (\"communityId\", \"callCreator\", \"channelId\", \"callServerId\", title, \"previewUserIds\", \"stageSlots\", \"scheduleDate\")
       VALUES ('$COMMUNITY', '$USER_ID', '$channel', $server, '$2', ARRAY['$USER_ID']::uuid[], 0, $sched) RETURNING id" | head -1
}
# add_member <callId> — present; add_member <callId> <left ago> <joined ago>
add_member() {
  if [ -n "${2:-}" ]; then
    sql "INSERT INTO callmembers (\"callId\", \"userId\", \"joinedAt\", \"leftAt\") VALUES ('$1', '$USER_ID', now() - interval '$3', now() - interval '$2')" >/dev/null
  else
    sql "INSERT INTO callmembers (\"callId\", \"userId\") VALUES ('$1', '$USER_ID')" >/dev/null
  fi
}
add_event() { # <callId> <scheduleDate-sql> <duration minutes> -> event id
  sql "INSERT INTO communities_events (\"communityId\", \"eventCreator\", \"callId\", type, title, description, \"scheduleDate\", duration)
       VALUES ('$COMMUNITY', '$USER_ID', '$1', 'call', 'check event', '{\"version\":\"2\",\"content\":[]}'::jsonb, $2, $3) RETURNING id" | head -1
}
ended() { [ -n "$(sql "SELECT 1 FROM calls WHERE id = '$1' AND \"endedAt\" IS NOT NULL")" ]; }
open_members() { sql "SELECT count(*) FROM callmembers WHERE \"callId\" = '$1' AND \"leftAt\" IS NULL"; }
wait_ended() { # <callId> <seconds>
  local i
  for i in $(seq 1 "$2"); do ended "$1" && return 0; sleep 1; done
  return 1
}
saw_delete() { # the Socket.IO emitter publication for this call id
  grep -a "$1" "$OUT/redis.log" 2>/dev/null | grep -a -q 'delete'
}
wait_delete() {
  local i
  for i in $(seq 1 "$2"); do saw_delete "$1" && return 0; sleep 1; done
  return 1
}

# --- Socket.IO emitter traffic: the job-runner publishes through
# @socket.io/redis-emitter with the key "v2:"; valkey-cli authenticates from
# REDISCLI_AUTH inside the container
: > "$OUT/redis.log"
docker exec "$P-redis-1" timeout 900 valkey-cli --no-auth-warning PSUBSCRIBE 'v2:#*' >> "$OUT/redis.log" 2>&1 &
SUB_PID=$!
sleep 2

# === 1. gone call server, job-runner running ==================================
GONE1=$(new_gone_server a)
CALL_GONE=$(new_call "$GONE1" 'check gone server')
add_member "$CALL_GONE"
log "case 1: call $CALL_GONE on gone server $GONE1 with a present member"
if wait_ended "$CALL_GONE" 40; then ok "case 1: call of the gone server ended"; else bad "case 1: call not ended within 40 s"; fi
sql "SELECT 'call', \"startedAt\", \"endedAt\", \"previewUserIds\" FROM calls WHERE id = '$CALL_GONE'" | tee -a "$LOG"
sql "SELECT 'member', \"joinedAt\", \"leftAt\" FROM callmembers WHERE \"callId\" = '$CALL_GONE'" | tee -a "$LOG"
[ "$(open_members "$CALL_GONE")" = 0 ] && ok "case 1: membership closed" || bad "case 1: membership still open"
if wait_delete "$CALL_GONE" 10; then ok "case 1: cliCallEvent delete published"; else bad "case 1: no delete event seen"; fi

# === 2. live call server, member present: must stay ============================
CALL_LIVE=$(new_call "$LIVE_SERVER" 'check live server')
add_member "$CALL_LIVE"
# === 3. live call server, everyone left 2 min ago: room gone -> ended =========
CALL_LEFT=$(new_call "$LIVE_SERVER" 'check all left')
sql "UPDATE calls SET \"startedAt\" = now() - interval '3 minutes' WHERE id = '$CALL_LEFT'" >/dev/null
add_member "$CALL_LEFT" '2 minutes' '3 minutes'
# === 3b. live call server, everyone left 5 s ago: still in the grace period ====
CALL_RECENT=$(new_call "$LIVE_SERVER" 'check left recently')
sql "UPDATE calls SET \"startedAt\" = now() - interval '3 minutes' WHERE id = '$CALL_RECENT'" >/dev/null
add_member "$CALL_RECENT" '5 seconds' '3 minutes'
# === 4. event calls on a gone server end right away, running or not ==========
GONE2=$(new_gone_server b)
CALL_EVENT_RUNNING=$(new_call "$GONE2" 'check event running' "now() - interval '30 minutes'")
add_event "$CALL_EVENT_RUNNING" "now() - interval '30 minutes'" 60 >/dev/null
add_member "$CALL_EVENT_RUNNING"
CALL_EVENT_OVER=$(new_call "$GONE2" 'check event over' "now() - interval '90 minutes'")
add_event "$CALL_EVENT_OVER" "now() - interval '90 minutes'" 60 >/dev/null
add_member "$CALL_EVENT_OVER"
# === 4b. scheduled call without an event row on a gone server ==================
CALL_NO_EVENT=$(new_call "$GONE2" 'check scheduled, no event' "now() - interval '5 minutes'")
add_member "$CALL_NO_EVENT"
# === 4c. scheduled call without an event row, never started (no server) =======
CALL_NO_EVENT_UNSTARTED=$(new_call NULL 'check scheduled, no event, no server' "now() + interval '1 day'")
sql "UPDATE calls SET \"startedAt\" = now() - interval '1 minute' WHERE id = '$CALL_NO_EVENT_UNSTARTED'" >/dev/null
# === 4d. event call (with event row) not started yet: must stay ==============
CALL_EVENT_FUTURE=$(new_call NULL 'check event future' "now() + interval '1 day'")
add_event "$CALL_EVENT_FUTURE" "now() + interval '1 day'" 60 >/dev/null
sql "UPDATE calls SET \"startedAt\" = now() - interval '1 minute' WHERE id = '$CALL_EVENT_FUTURE'" >/dev/null
log "case 2 live=$CALL_LIVE, 3 left=$CALL_LEFT, 3b recent=$CALL_RECENT, 4 running=$CALL_EVENT_RUNNING over=$CALL_EVENT_OVER, 4b $CALL_NO_EVENT, 4c $CALL_NO_EVENT_UNSTARTED, 4d $CALL_EVENT_FUTURE"

if wait_ended "$CALL_LEFT" 10; then ok "case 3: all-left call on a live server ended"; else bad "case 3: all-left call not ended"; fi
if wait_delete "$CALL_LEFT" 10; then ok "case 3: delete event published"; else bad "case 3: no delete event"; fi
for c in "$CALL_EVENT_RUNNING:running event call (30 of 60 min)" "$CALL_EVENT_OVER:event call past its end" "$CALL_NO_EVENT:scheduled call without event row"; do
  id="${c%%:*}"; what="${c#*:}"
  if wait_ended "$id" 40; then ok "case 4: $what on a gone server ended"; else bad "case 4: $what on a gone server not ended"; fi
  [ "$(open_members "$id")" = 0 ] && ok "case 4: $what: memberships closed" || bad "case 4: $what: membership still open"
  [ "$(sql "SELECT cardinality(\"previewUserIds\") FROM calls WHERE id = '$id'")" = 0 ] && ok "case 4: $what: previewUserIds cleared" || bad "case 4: $what: previewUserIds not cleared"
done
if wait_ended "$CALL_NO_EVENT_UNSTARTED" 20; then ok "case 4c: scheduled call without event row and server ended"; else bad "case 4c: scheduled call without event row not ended"; fi
# give every sweep at least one more full round
sleep 20
ended "$CALL_LIVE" && bad "case 2: call with a present member on a live server was ended" || ok "case 2: call on a live server with a present member still open"
ended "$CALL_RECENT" && bad "case 3b: call ended within the 60 s grace" || ok "case 3b: call whose members left 5 s ago still open (grace period)"
ended "$CALL_EVENT_FUTURE" && bad "case 4d: future event call was ended" || ok "case 4d: future event call (not started) still open"
saw_delete "$CALL_LIVE" && bad "case 2: delete event for an open call" || ok "case 2: no delete event for the open call"
# nothing stale in the lists the clients read (community detail, home page)
STALE=$(sql "SELECT count(*) FROM calls cl INNER JOIN callservers cs ON cs.id = cl.\"callServerId\" WHERE cl.\"endedAt\" IS NULL AND (cs.\"deletedAt\" IS NOT NULL OR cs.\"updatedAt\" < now() - interval '60 seconds')")
[ "$STALE" = 0 ] && ok "lists: no open call on a gone call server left" || bad "lists: $STALE open call(s) on gone call servers"

# === 5. job-runner startup: calls ended at startup reach the clients ===========
log "case 5: stopping job-runner"
docker stop -t 10 "$P-job-runner-1" >/dev/null
GONE3=$(new_gone_server c)
CALL_STARTUP=$(new_call "$GONE3" 'check startup')
add_member "$CALL_STARTUP"
log "case 5: startup=$CALL_STARTUP; starting job-runner"
docker start "$P-job-runner-1" >/dev/null
if wait_ended "$CALL_STARTUP" 60; then ok "case 5: gone call ended at job-runner startup"; else bad "case 5: gone call not ended after startup"; fi
if wait_delete "$CALL_STARTUP" 10; then ok "case 5: delete event for the call ended at startup published"; else bad "case 5: no delete event for the call ended at startup"; fi
docker logs --since 3m "$P-job-runner-1" 2>&1 | grep -a -i 'call\|error' | tail -30 > "$OUT/job-runner.log"

# === 6. an ended event call can be started again ===============================
# ended like by a call server restart, with a membership left open
CALL_RESTART=$(new_call "$GONE3" 'check event restart' "now() - interval '10 minutes'")
EVENT_RESTART=$(add_event "$CALL_RESTART" "now() - interval '10 minutes'" 60)
add_member "$CALL_RESTART"
sql "UPDATE calls SET \"endedAt\" = now() WHERE id = '$CALL_RESTART'" >/dev/null
RESTART_OUT=$(api_node "
const calls = require('/dist/repositories/calls.js').default;
(async () => {
  const started = await calls.startScheduledCall({ communityEventId: '$EVENT_RESTART', callStarter: '$USER_ID' });
  // what the call server's getOrCreateRoom reads: it rejects a call with endedAt
  const state = await calls.getCallState('$CALL_RESTART');
  console.log('RESTART', started.id === '$CALL_RESTART', !!state && state.endedAt === null);
  process.exit(0);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
")
echo "$RESTART_OUT" >> "$LOG"
echo "$RESTART_OUT" | grep -q '^RESTART true true' \
  && [ "$(sql "SELECT \"callServerId\" FROM calls WHERE id = '$CALL_RESTART'")" = "$LIVE_SERVER" ] \
  && ok "case 6: ended event call restarted (endedAt NULL, assigned to the live call server: getOrCreateRoom accepts it)" \
  || bad "case 6: restart: $RESTART_OUT"
[ "$(open_members "$CALL_RESTART")" = 0 ] && ok "case 6: stale membership of the ended call closed" || bad "case 6: stale membership still open"
sleep 20
ended "$CALL_RESTART" && bad "case 6: restarted event call was ended again" || ok "case 6: restarted event call still open after 20 s (joinable)"

# === 7. updateCallPermissions without role permissions (SQL comma) ===========
PERM_OUT=$(api_node "
const calls = require('/dist/repositories/calls.js').default;
const pool = require('/dist/util/postgres.js').default;
(async () => {
  await calls.updateCallPermissions('$CALL_LIVE', '$COMMUNITY', undefined);
  const r = await pool.query('SELECT \"roleId\" FROM callpermissions WHERE \"callId\" = \$1', ['$CALL_LIVE']);
  console.log('ROWS', r.rows.length);
  process.exit(0);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
")
echo "$PERM_OUT" >> "$LOG"
echo "$PERM_OUT" | grep -q '^ROWS 2' && ok "case 7: updateCallPermissions(…, undefined) wrote admin + member rows" || bad "case 7: updateCallPermissions: $PERM_OUT"

# === 8. setChannelLastRead never moves backwards, never into the future =======
CHANNEL=$(sql "SELECT \"channelId\" FROM communities_channels WHERE \"communityId\" = '$COMMUNITY' LIMIT 1")
# start without a stored read marker for this user and channel
sql "DELETE FROM channelreadstate WHERE \"userId\" = '$USER_ID' AND \"channelId\" = '$CHANNEL'" >/dev/null
LR_OUT=$(api_node "
const messages = require('/dist/repositories/messages.js').default;
(async () => {
  const access = { communityId: '$COMMUNITY', channelId: '$CHANNEL' };
  const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();
  const t1 = hoursAgo(1), t2 = hoursAgo(2), t3 = hoursAgo(3);
  const a = (await messages.setChannelLastRead('$USER_ID', { access, lastRead: t2 })).lastRead;
  const b = (await messages.setChannelLastRead('$USER_ID', { access, lastRead: t3 })).lastRead;
  const c = (await messages.setChannelLastRead('$USER_ID', { access, lastRead: t1 })).lastRead;
  const d = (await messages.setChannelLastRead('$USER_ID', { access, lastRead: '2999-01-01T00:00:00.000Z' })).lastRead;
  const clamped = Math.abs(new Date(d).getTime() - Date.now()) < 60000;
  console.log('LASTREAD', a === t2, b === t2, c === t1, clamped);
  process.exit(0);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
")
echo "$LR_OUT" >> "$LOG"
echo "$LR_OUT" | grep -q '^LASTREAD true true true true' \
  && ok "case 8: older lastRead ignored, newer accepted, future clamped to now" || bad "case 8: $LR_OUT"

# end what this check left open (the instance is torn down anyway)
sql "UPDATE calls SET \"endedAt\" = now() WHERE title LIKE 'check %' AND \"endedAt\" IS NULL" >/dev/null
sql "DELETE FROM channelreadstate WHERE \"userId\" = '$USER_ID' AND \"channelId\" = '$CHANNEL'" >/dev/null
sleep 2
kill "$SUB_PID" 2>/dev/null
docker exec "$P-redis-1" pkill -f 'valkey-cli' 2>/dev/null || true
log "done: $FAILS failure(s); log and emitter traffic in $OUT"
exit $(( FAILS > 0 ? 1 : 0 ))
