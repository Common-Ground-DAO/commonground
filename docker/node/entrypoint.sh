#!/bin/bash
echo "------------------------------------------------------------"
echo "This is your local project folder, mounted into a docker container"
echo "based on node:24.18-bookworm. Your project folder is mounted at /cg"
echo "------------------------------------------------------------"
exec "$@"