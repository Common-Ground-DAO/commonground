// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { Bot } from "./bots";
import { Community } from "./communities";

@Entity({ name: 'bots_platform_communities' })
export class BotPlatformCommunity {
  @PrimaryColumn({ type: 'uuid' })
  botUserId!: string;

  @ManyToOne(() => Bot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'botUserId', referencedColumnName: 'userId' })
  bot!: Bot;

  @PrimaryColumn({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'communityId', referencedColumnName: 'id' })
  community!: Community;
}
