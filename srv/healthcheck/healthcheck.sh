#!/bin/bash
# HEALTHCHECK of the backend image (docker/backend/Dockerfile*): healthy while
# the process's own report (srv/healthcheck.ts, rewritten every ~10-15 s in
# the working directory) says "ok" and is fresh. A stale report means the
# process (or its event loop) hangs. Prints the report, which Docker keeps in
# the container's health log (docker inspect).
file=healthcheck.txt
max_age=30

if [ ! -f "$file" ]; then
  echo "no report yet ($file)"
  exit 1
fi
age=$(( $(date +%s) - $(stat -c %Y "$file") ))
cat "$file"
if [ "$age" -gt "$max_age" ]; then
  echo "report is ${age} s old (more than ${max_age} s): the process does not update it"
  exit 1
fi
[ "$(head -n 1 "$file")" = "ok" ]
