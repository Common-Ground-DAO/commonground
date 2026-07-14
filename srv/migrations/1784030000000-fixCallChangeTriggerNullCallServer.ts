// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm"

// Fixes https://github.com/Common-Ground-DAO/commonground/issues/1
//
// Scheduled calls (every event call) are created with "callServerId" NULL —
// a call server is only assigned when the call starts. When such a call was
// updated with changed slots/stageSlots/highQuality/audioOnly (e.g. editing
// an event and switching Broadcast <-> Group call, which changes stageSlots),
// the trigger built its notify channel from the NULL callServerId:
//
//   'callservercallupdate_' || NULL  ->  NULL
//   pg_notify(NULL, ...)             ->  ERROR: channel name cannot be empty
//
// which aborted the whole UPDATE and made saving the event fail. Skip the
// call-server notification when no call server is assigned yet — there is
// no listener on that channel anyway, and the server receives the full call
// state when it is assigned at call start.
export class FixCallChangeTriggerNullCallServer1784030000000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION notify_call_change() RETURNS trigger AS $$
            DECLARE
            BEGIN
                PERFORM pg_notify('callchange',
                json_build_object(
                'type', 'callchange',
                'id', NEW.id,
                'communityId', NEW."communityId",
                'channelId', NEW."channelId",
                'callServerId', NEW."callServerId",
                'title', NEW."title",
                'description', NEW."description",
                'previewUserIds', NEW."previewUserIds",
                'slots', NEW."slots",
                'startedAt', NEW."startedAt",
                'updatedAt', NEW."updatedAt",
                'endedAt', NEW."endedAt",
                'stageSlots', NEW."stageSlots",
                'highQuality', NEW."highQuality",
                'audioOnly', NEW."audioOnly",
                'action', TG_OP
                )::text
                );

                IF TG_OP = 'UPDATE'
                AND NEW."callServerId" IS NOT NULL
                AND NEW."endedAt" IS NULL
                AND (
                    OLD."slots" <> NEW."slots"
                    OR OLD."stageSlots" <> NEW."stageSlots"
                    OR OLD."highQuality" <> NEW."highQuality"
                    OR OLD."audioOnly" <> NEW."audioOnly"
                )
                THEN
                    PERFORM pg_notify('callservercallupdate_' || REPLACE(NEW."callServerId"::text, '-', '_'),
                    json_build_object(
                    'type', 'callservercallupdate_' || REPLACE(NEW."callServerId"::text, '-', '_'),
                    'callId', NEW.id,
                    'slots', NEW."slots",
                    'stageSlots', NEW."stageSlots",
                    'highQuality', NEW."highQuality",
                    'audioOnly', NEW."audioOnly"
                    )::text
                    );
                END IF;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
    }

}
