// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class initdb1648214442313 implements MigrationInterface {
    name = 'initdb1648214442313'

    public async up(queryRunner: QueryRunner): Promise<void> {
        try {
            await queryRunner.query(`CREATE TABLE "accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "address" character varying(50) NOT NULL, "alias" character varying(50) DEFAULT NULL, "public_key" jsonb, "public_key_signature" character varying(132) DEFAULT NULL, "key_storage" jsonb, "key_storage_signature" character varying(132) DEFAULT NULL, "profile" jsonb, "profile_signature" character varying(132) DEFAULT NULL, "app_data" jsonb, "trust" real DEFAULT '0', "required_dm_trust" real DEFAULT '0', "txcount_brought" integer DEFAULT '0', "created" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), CONSTRAINT "UQ_48ec5fcf335b99d4792dd5e4537" UNIQUE ("address"), CONSTRAINT "UQ_a5f4f991f324bd85b79afb8d371" UNIQUE ("alias"), CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE INDEX "idx_accounts_address" ON "accounts" ("address") `);
            await queryRunner.query(`CREATE TABLE "groups" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "info" jsonb NOT NULL, "access_changed" TIMESTAMP(3) WITH TIME ZONE DEFAULT NULL, "created" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), "creator" uuid NOT NULL, CONSTRAINT "PK_659d1483316afb28afd3a90646e" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE TABLE "channels" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" character varying(100) NOT NULL, "type" character varying(10) NOT NULL, "access_changed" TIMESTAMP(3) WITH TIME ZONE DEFAULT NULL, "group_id" uuid NOT NULL, CONSTRAINT "PK_bc603823f3f741359c2339389f9" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE TABLE "access" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "rules" jsonb NOT NULL, "updated" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), "group_id" uuid NOT NULL, "channel_id" uuid, CONSTRAINT "UQ_3813086ac0b9c33b82ae94123db" UNIQUE ("channel_id"), CONSTRAINT "PK_e386259e6046c45ab06811584ed" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE TABLE "linkedaddresses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "message" jsonb NOT NULL, "signature" character varying(132) NOT NULL, "public" boolean NOT NULL DEFAULT false, "deleted" boolean DEFAULT false, "owner_account_changed" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), "account_id" uuid NOT NULL, CONSTRAINT "PK_3fef8516de144ea06854b32ab3c" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE UNIQUE INDEX "idx_unique_linkedaddresses" ON "linkedaddresses" ((message->>'linkedAddress')) `);
            await queryRunner.query(`CREATE TABLE "channelaccess" ("linkedaddress_id" uuid NOT NULL, "access_id" uuid NOT NULL, "updated_at_block" bigint NOT NULL, "account_id" uuid NOT NULL, CONSTRAINT "channelaccess_linkedaddress_id_access_id_key" UNIQUE ("linkedaddress_id", "access_id"), CONSTRAINT "PK_b712e8d612ec3c87965d9df3b05" PRIMARY KEY ("linkedaddress_id", "access_id"))`);
            await queryRunner.query(`CREATE TABLE "conversations" ("account_id" uuid NOT NULL, "other_account_id" uuid NOT NULL, "last_read" TIMESTAMP(3) WITH TIME ZONE DEFAULT NULL, CONSTRAINT "conversations_account_id_other_account_id_key" UNIQUE ("account_id", "other_account_id"), CONSTRAINT "PK_1e7ba28dc287cca6fc04f9c5e00" PRIMARY KEY ("account_id", "other_account_id"))`);
            await queryRunner.query(`CREATE TABLE "contracts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "chain" character varying(10) NOT NULL, "address" character varying(50) NOT NULL, "data" jsonb NOT NULL, "updated_at_block" bigint, CONSTRAINT "contracts_chain_address_key" UNIQUE ("chain", "address"), CONSTRAINT "PK_2c7b8f3a7b1acdd49497d83d0fb" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE TYPE "public"."groupaccess_accesslevel_enum" AS ENUM('admin', 'moderator', 'user')`);
            await queryRunner.query(`CREATE TABLE "groupaccess" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "accesslevel" "public"."groupaccess_accesslevel_enum" NOT NULL DEFAULT 'user', "updated_at_block" bigint, "account_id" uuid NOT NULL, "access_id" uuid NOT NULL, "linkedaddress_id" uuid, CONSTRAINT "groupaccess_linkedaddress_id_access_id_key" UNIQUE ("linkedaddress_id", "access_id"), CONSTRAINT "PK_bc70b97b1da0c597eb8d659ce40" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE TABLE "groupblocks" ("group_id" uuid NOT NULL, "account_id" uuid NOT NULL, "until" TIMESTAMP(3) WITH TIME ZONE DEFAULT NULL, CONSTRAINT "groupblocks_group_id_account_id_key" UNIQUE ("group_id", "account_id"), CONSTRAINT "PK_46f84a16aaad0486ed2dee63e8e" PRIMARY KEY ("group_id", "account_id"))`);
            await queryRunner.query(`CREATE TABLE "messages" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "message" jsonb NOT NULL, "signature" character varying(132) NOT NULL, "created" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), "from_id" uuid NOT NULL, "to_id" uuid NOT NULL, CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE TABLE "posts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "message" jsonb NOT NULL, "signature" character varying(132) NOT NULL, "created" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), "account_id" uuid NOT NULL, CONSTRAINT "PK_2829ac61eff60fcec60d7274b9e" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE INDEX "idx_posts_accounts" ON "posts" ("account_id") `);
            await queryRunner.query(`CREATE INDEX "idx_posts_created" ON "posts" ("created") `);
            await queryRunner.query(`CREATE INDEX "idx_posts_channel_group" ON "posts" (UUID(message->>'groupId'), UUID(message->>'channelId')) `);
            await queryRunner.query(`CREATE TABLE "reactions" ("account_id" uuid NOT NULL, "item_id" uuid NOT NULL, "reaction" character varying(3) NOT NULL, CONSTRAINT "reactions_account_id_item_id_key" UNIQUE ("account_id", "item_id"), CONSTRAINT "PK_bf5236a977d7677bcdaee827531" PRIMARY KEY ("account_id", "item_id"))`);
            await queryRunner.query(`CREATE INDEX "idx_reactions_item" ON "reactions" ("item_id") `);
            await queryRunner.query(`CREATE TABLE "txcount" ("linkedaddress_id" uuid NOT NULL, "chain" character varying(10) NOT NULL, "txcount" integer NOT NULL, "updated" TIMESTAMP(3) WITH TIME ZONE DEFAULT now(), CONSTRAINT "txcount_linkedaddress_id_chain_key" UNIQUE ("linkedaddress_id", "chain"), CONSTRAINT "PK_19c2b99a54211200ebd42da906f" PRIMARY KEY ("linkedaddress_id"))`);
            await queryRunner.query(`CREATE TABLE "userblocks" ("account_id" uuid NOT NULL, "other_account_id" uuid NOT NULL, CONSTRAINT "userblocks_account_id_other_account_id_key" UNIQUE ("account_id", "other_account_id"), CONSTRAINT "PK_7a83d41da89c2e945bc5ea48c95" PRIMARY KEY ("account_id", "other_account_id"))`);
            await queryRunner.query(`ALTER TABLE "groups" ADD CONSTRAINT "FK_8d965035a4b4ad05d836ad82770" FOREIGN KEY ("creator") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "channels" ADD CONSTRAINT "FK_35ab26042dde5cddce5c040797e" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "access" ADD CONSTRAINT "FK_6a36f88265e6c07bd59939df05c" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "access" ADD CONSTRAINT "FK_3813086ac0b9c33b82ae94123db" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "linkedaddresses" ADD CONSTRAINT "FK_417709a5aa8fd3bd7786f3ebb68" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "channelaccess" ADD CONSTRAINT "FK_e4268a0405d2f768b8818ded1ab" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "channelaccess" ADD CONSTRAINT "FK_c2bcd0f89a2102bd6baee6878ee" FOREIGN KEY ("access_id") REFERENCES "access"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "channelaccess" ADD CONSTRAINT "FK_3cac5fedc05b104a8725801d3ab" FOREIGN KEY ("linkedaddress_id") REFERENCES "linkedaddresses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "FK_948676628b2911729a80645685d" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "FK_64405a22fa9971f9530d7e474a3" FOREIGN KEY ("other_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "groupaccess" ADD CONSTRAINT "FK_001365109690d0d573114a9c6d2" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "groupaccess" ADD CONSTRAINT "FK_95cfd88b9bfa27d76a0efa6b9d0" FOREIGN KEY ("access_id") REFERENCES "access"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "groupaccess" ADD CONSTRAINT "FK_b8e1ab4127db8a5e0ee6f79595d" FOREIGN KEY ("linkedaddress_id") REFERENCES "linkedaddresses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "groupblocks" ADD CONSTRAINT "FK_3f36fbb53a57f3b0a90d728c770" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "groupblocks" ADD CONSTRAINT "FK_b6b5a26a3066c1cf22f364cb5b6" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "FK_ad62e2ac4a556ceaf98330b2910" FOREIGN KEY ("from_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "FK_d8762108151bf40db7c99a98612" FOREIGN KEY ("to_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "posts" ADD CONSTRAINT "FK_e3bab03a7dee745151598930014" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "reactions" ADD CONSTRAINT "FK_024940b15a583bf99ad3a575d68" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "txcount" ADD CONSTRAINT "FK_19c2b99a54211200ebd42da906f" FOREIGN KEY ("linkedaddress_id") REFERENCES "linkedaddresses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "userblocks" ADD CONSTRAINT "FK_a6f37553e796c42aa09c22d5f97" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "userblocks" ADD CONSTRAINT "FK_4bd7607429a659f1de621705b54" FOREIGN KEY ("other_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);

            await queryRunner.query(`ALTER TABLE "channelaccess" ADD CONSTRAINT "channelaccess_linkedaddress_id_access_id_key" UNIQUE ("linkedaddress_id", "access_id")`);
            await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_other_account_id_key" UNIQUE ("account_id", "other_account_id")`);
            await queryRunner.query(`ALTER TABLE "groupblocks" ADD CONSTRAINT "groupblocks_group_id_account_id_key" UNIQUE ("group_id", "account_id")`);
            await queryRunner.query(`ALTER TABLE "reactions" ADD CONSTRAINT "reactions_account_id_item_id_key" UNIQUE ("account_id", "item_id")`);
            await queryRunner.query(`ALTER TABLE "userblocks" ADD CONSTRAINT "userblocks_account_id_other_account_id_key" UNIQUE ("account_id", "other_account_id")`);
        } catch (err) {
            console.log('It seems like database is already existing')
        }

        // update permissions for new created tables
        const connectionOptions = queryRunner.dataSource.options;
        const database = connectionOptions.database;
        try {
            await queryRunner.query(`GRANT CONNECT on DATABASE ${database} TO writer`);
            await queryRunner.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO writer`);
            await queryRunner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO writer`);
        } catch (err) {
            console.log('Cannot grant privileges to writer');
        }

        try {
            await queryRunner.query(`GRANT CONNECT on DATABASE ${database} TO reader`);
            await queryRunner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader`);
            await queryRunner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reader`);
        } catch (err) {
            console.log('Cannot grant privileges to reader');
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        //nothing to do on down app
    }
}
