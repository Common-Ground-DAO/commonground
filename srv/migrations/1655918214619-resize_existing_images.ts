// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm"

export class resizeExistingImages1655918214582 implements MigrationInterface {
    name = 'resizeExistingImages1655918214582'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (process.env.DEPLOYMENT !== "dev") {
            // downscale existing images, only required
            // in staging and prod

            // Already executed in all environments
            // and not required for fresh environments
            /*
            const communities: Pick<Group, 'id'|'info'>[] = await queryRunner.query(`
                SELECT id, info FROM groups
                WHERE info->>'imageId' IS NOT NULL;
            `);
            for (const community of communities) {
                const { imageId } = community.info;
                if (imageId) {
                    const buffer = await fileHelper.getFile(imageId);
                    if (buffer !== null) {
                        try {
                            const newObjectId = await fileHelper.saveImage(null, { type: 'communityLogoSmall' }, buffer, { width: 150, height: 150 }, { skipModeration: true });
                            await queryRunner.query(`
                                UPDATE groups
                                SET info = jsonb_set(info, '{imageId}', $2)
                                WHERE id = $1;
                            `, [community.id, JSON.stringify(newObjectId)]);
                            console.log(`community ${community.id}: image downscaled (old: ${imageId}, new: ${newObjectId})`);

                        } catch (e) {
                            console.log(`community ${community.id}: image cannot be downscaled`);
                        }
                    }
                }
            }
            const accounts: { id: string, imageId: string }[] = await queryRunner.query(`
                SELECT id, "imageId" FROM accounts
                WHERE "imageId" IS NOT NULL;
            `);
            for (const account of accounts) {
                const { imageId } = account;
                if (imageId) {
                    const buffer = await fileHelper.getFile(imageId);
                    if (buffer !== null) {
                        try {
                            const newObjectId = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 }, { skipModeration: true });
                            await queryRunner.query(`
                                UPDATE accounts
                                SET "imageId" = $2
                                WHERE id = $1;
                            `, [account.id, newObjectId]);
                            console.log(`account ${account.id}: image downscaled (old: ${imageId}, new: ${newObjectId})`);

                        } catch (e) {
                            console.log(`account ${account.id}: image cannot be downscaled`);
                        }
                    }
                }
            }
            */
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
    }

}
