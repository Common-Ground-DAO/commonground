// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Unique,
  Index,
} from "typeorm";

/**
 * One permanent delivery failure reported by the selfhost mail relay
 * (srv/jobs/bounceReceiver.ts, docs/email-notifications "Bounces"). An address
 * is only marked unverified after repeated bounces (srv/util/bouncePolicy.ts);
 * rows recorded while many addresses bounced at once are flagged senderSide
 * and never count. Keyed by the normalized address rather than a user id: the
 * report names an address, and an account may have changed its address since.
 * Rows older than the retention period are deleted by the newsletterDelivery job.
 */
@Entity({ name: 'email_bounces' })
@Unique('UQ_email_bounces_report_address', ['reportId', 'address'])
@Index('idx_email_bounces_address_createdAt', { synchronize: false })
@Index('idx_email_bounces_createdAt', { synchronize: false })
export class EmailBounce {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** lower-cased recipient address from the report */
  @Column({ type: 'varchar', length: 320, nullable: false })
  address!: string;

  /** Message-ID of the bounce report: one report = one failed message */
  @Column({ type: 'varchar', length: 255, nullable: false })
  reportId!: string;

  /** Status field of the report, e.g. 5.0.0 */
  @Column({ type: 'varchar', length: 16, nullable: false })
  status!: string;

  /** Diagnostic-Code of the report (the receiving server's answer), truncated */
  @Column({ type: 'varchar', length: 500, nullable: true })
  diagnostic!: string | null;

  /** recorded during a burst of bounces — likely a problem of this server, not of the address */
  @Column({ type: 'boolean', nullable: false, default: false })
  senderSide!: boolean;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
