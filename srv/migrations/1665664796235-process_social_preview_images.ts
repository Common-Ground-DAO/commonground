// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm"

export class processSocialPreviewImages1665664796167 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Already executed in all environments
        // and not required for fresh environments
        /*
        const updatePreviewImages = async () => {
            const communities: Pick<Group, 'id' | 'info'>[] = await queryRunner.query(`
                SELECT id, info
                FROM groups
                WHERE deleted = FALSE AND info->>'imageId' IS NOT NULL AND preview_image_id IS NULL;
            `);
            for (const community of communities) {
                const { imageId } = community.info;
                if (imageId) {
                    let buffer: Buffer | null = null;
                    try {
                        buffer = await fileHelper.getFile(imageId);
                    } catch (err) {
                        console.log(`community ${community.id}: image does not exist in backet, let's use placeholder`);
                        // use community image placeholder for that
                        buffer = Buffer.from(`<svg width="150" height="150" viewBox="0 0 153 152" fill="none">
                            <path d="M68.5489 4.6188C73.4993 1.76068 79.5984 1.76068 84.5489 4.6188L134.074 33.2119C139.024 36.07 142.074 41.3521 142.074 47.0683V104.255C142.074 109.971 139.024 115.253 134.074 118.111L84.5489 146.704C79.5984 149.562 73.4993 149.562 68.5489 146.704L19.0242 118.111C14.0737 115.253 11.0242 109.971 11.0242 104.255V47.0683C11.0242 41.3521 14.0737 36.07 19.0242 33.2119L68.5489 4.6188Z" fill="#2D2D2D"/>
                            <path d="M101.083 70.9111V61.4111L92.9043 56.6611L84.7255 51.9111L76.5466 47.1611V56.6611V66.1611V75.6611L84.7255 80.4111L92.9043 85.1611L101.083 89.9111V80.4111V70.9111Z" fill="#F2DCC2"/>
                            <path d="M92.9043 94.6611L101.083 89.9111L92.9043 85.1611L84.7254 80.4111L76.5466 75.6611L68.3677 80.4111L60.1889 85.1611L52.01 89.9111L60.1889 94.6611L68.3677 99.4111L76.5466 104.161L84.7254 99.4111L92.9043 94.6611ZM84.7254 99.4111L92.9043 94.6611L84.7254 99.4111Z" fill="#4449B3"/>
                            <path d="M117.446 51.9111L109.267 56.6611L101.083 61.4111V70.9111V80.4111V89.9111V118.411L109.267 113.661L117.446 108.911L125.625 104.161V94.6611V85.1611V75.6611V66.1611V56.6611V47.1611L117.446 51.9111Z" fill="#191919"/>
                            <path d="M92.9043 94.6611L84.7255 99.4111L76.5466 104.161V113.661V123.161V132.661L84.7255 127.911L92.9043 123.161L101.083 118.411V89.9111L92.9043 94.6611Z" fill="#191919"/>
                            <path d="M68.3677 99.4111L60.1888 94.6611L52.01 89.9111V80.4111V70.9111V61.4111L43.8311 56.6611L35.6522 51.9111L27.4734 47.1611V56.6611V66.1611V75.6611V85.1611V94.6611V104.161L35.6522 108.911L43.8311 113.661L52.01 118.411L60.1888 123.161L68.3677 127.911L76.5465 132.661V123.161V113.661V104.161L68.3677 99.4111Z" fill="#F2DCC2"/>
                            <path d="M68.3677 51.9111L60.1889 56.6611L52.01 61.4111V70.9111V80.4111V89.9111L60.1889 85.1611L68.3677 80.4111L76.5466 75.6611V66.1611V56.6611V47.1611L68.3677 51.9111Z" fill="#191919"/>
                            <path d="M125.624 47.1611L76.5465 18.6611L27.4734 47.1611L52.01 61.4111L76.5465 47.1611L101.083 61.4111L125.624 47.1611Z" fill="#4449B3"/>
                        </svg>`);
                    }
                    if (buffer !== null) {
                        try {
                            const composedImage = await fileHelper.composeCommunityImage(buffer);
                            if (composedImage) {
                                const previewImage = await fileHelper.saveImage(null, { type: "communityLogoSmall" }, composedImage, undefined, { skipModeration: true });
                                await queryRunner.query(`
                                    UPDATE groups
                                    SET preview_image_id = $2
                                    WHERE id = $1;
                                `, [community.id, previewImage.fileId]);
                                console.log(`community ${community.id}: processed social preview image (old: ${imageId}, new: ${previewImage.fileId})`);

                            }
                        } catch (e) {
                            console.log(`community ${community.id}: image cannot be processed to social preview image`);
                        }
                    }
                }
            }

            const accounts: { id: string, imageId: string }[] = await queryRunner.query(`
                SELECT id, "imageId"
                FROM accounts
                WHERE deleted = FALSE AND "imageId" IS NOT NULL AND preview_image_id IS NULL;
            `);
            for (const account of accounts) {
                const { imageId } = account;
                if (imageId) {
                    let buffer: Buffer | null = null;
                    try {
                        buffer = await fileHelper.getFile(imageId);
                    } catch (err) {
                        console.log(`account ${account.id}: image does not exist in backet, let's use default avatar`);
                        buffer = Buffer.from(`<svg viewBox="0 0 80 80" fill="none" width="300" height="300">
                            <mask id="mask__marble" maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="80">
                                <rect width="80" height="80" rx="160" fill="#FFFFFF"></rect>
                            </mask>
                            <g mask="url(#mask__marble)">
                                <rect width="80" height="80" fill="#F2DCC2"></rect>
                                <path filter="url(#prefix__filter0_f)" d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z" fill="#4449B3" transform="translate(6 6) rotate(110 40 40) scale(1.3)"></path>
                                <path filter="url(#prefix__filter0_f)" d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z" fill="#4D4D4D" transform="translate(-5 5) rotate(-165 40 40) scale(1.3)" style="mix-blend-mode: overlay;"></path>
                            </g>
                            <defs>
                                <filter id="prefix__filter0_f" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                                    <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
                                    <feGaussianBlur stdDeviation="7" result="effect1_foregroundBlur"></feGaussianBlur>
                                </filter>
                            </defs>
                        </svg>`);
                    }

                    if (buffer !== null) {
                        try {
                            const composedImage = await fileHelper.composeProfileImage(buffer);
                            if (composedImage) {
                                const previewImage = await fileHelper.saveImage(null, { type: "communityLogoSmall" }, composedImage, undefined, { skipModeration: true });
                                await queryRunner.query(`
                                    UPDATE accounts
                                    SET preview_image_id = $2
                                    WHERE id = $1;
                                `, [account.id, previewImage.fileId]);
                                console.log(`account ${account.id}: processed social preview image (old: ${imageId}, new: ${previewImage.fileId})`);
                            }

                        } catch (e) {
                            console.log(`account ${account.id}: image cannot be processed to social preview image`);
                        }
                    }
                }
            }
        };
        if (process.env.DEPLOYMENT !== "dev") {
            return updatePreviewImages();
        } else {
            return new Promise(resolve => setTimeout(() => {
                resolve(updatePreviewImages());
            }, 30000));
        }
        */
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
    }
}
