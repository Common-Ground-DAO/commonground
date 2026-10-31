#!/bin/bash
# Runs once, when the official postgres entrypoint initializes an empty data
# directory (docker-entrypoint-initdb.d). Creates the application database and
# every login role the app uses, so a fresh cluster can take either the
# migration chain (migrate-db) or a pg_restore of an existing database whose
# ACLs name these roles. The migrations grant the table privileges; the
# addMediasoupRole migration only creates the mediasoup role where it is
# still missing (PG_MEDIASOUP_PASSWORD empty at init).
# Any SQL error fails the script, and with it the first start: the entrypoint
# exits with the error in the log. The data directory is then initialized
# but incomplete (a restart would come up without the database or roles), so
# remove the volume before starting again.
set -e
until pg_isready; do
	echo "DB not ready..."
	sleep 1
done
cryptogram_exists=$(psql -v ON_ERROR_STOP=1 -A -t -c "SELECT COUNT(*) FROM pg_database WHERE datname='cryptogram';")
if [ "$cryptogram_exists" = "1" ]
then
	echo "Database exists, exiting..."
else
	echo "Database doesn't exist, creating database..."
	cat <<-EOF | psql -v ON_ERROR_STOP=1 -f -
	CREATE DATABASE cryptogram ENCODING 'utf8';
	\c cryptogram;

	CREATE ROLE writer LOGIN PASSWORD '$PG_WRITER_PASSWORD';

	CREATE ROLE reader LOGIN PASSWORD '$PG_READER_PASSWORD';

	EOF
	if [ -n "$PG_MEDIASOUP_PASSWORD" ]
	then
		psql -v ON_ERROR_STOP=1 -c "CREATE ROLE mediasoup LOGIN PASSWORD '$PG_MEDIASOUP_PASSWORD';"
	fi
fi
exit 0
