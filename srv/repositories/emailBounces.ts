// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import pool from "../util/postgres";
import { bumpSecurityStepVersion } from "../util/securityStepVersion";
import type { DsnRecipient } from "../util/dsn";
import {
  addressesToUnverify,
  detectBurst,
  inBurst,
  type BouncePolicy,
  type Burst,
} from "../util/bouncePolicy";

// email_bounces (entities/email-bounces.ts): permanent bounces from the
// selfhost mail relay, and the policy that turns them into unverified
// addresses (srv/util/bouncePolicy.ts, docs/email-notifications "Bounces").

/** rows older than this are deleted (newsletterDelivery job) */
export const BOUNCE_RETENTION_DAYS = 180;

const DIAGNOSTIC_MAX = 500;

export type BounceReportResult = {
  recorded: number;
  burst: Burst;
  /** addresses the policy decided to unverify */
  unverify: string[];
  /** users actually changed (rowCount: an address may match no verified user) */
  usersUnverified: number;
};

class EmailBounceHelper {
  /**
   * Records the permanent failures of one bounce report and applies the
   * policy, in one transaction (serialized, so concurrent reports see each
   * other). Throws on database errors — the receiver then answers 451 and
   * the relay retries; re-recording the same report is a no-op.
   */
  public async recordReport(
    reportId: string,
    failed: DsnRecipient[],
    policy: BouncePolicy,
  ): Promise<BounceReportResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('email-bounces', 0))`);

      const inserted = await client.query(`
        INSERT INTO email_bounces (address, "reportId", status, diagnostic)
        SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
        ON CONFLICT ("reportId", address) DO NOTHING
      `, [
        failed.map(r => r.address),
        failed.map(() => reportId),
        failed.map(r => r.status.slice(0, 16)),
        failed.map(r => r.diagnostic ? r.diagnostic.slice(0, DIAGNOSTIC_MAX) : null),
      ]);

      // burst detection over every permanent bounce in the window
      const windowRows = await client.query<{ address: string }>(`
        SELECT address FROM email_bounces
        WHERE "createdAt" > now() - make_interval(secs => $1)
      `, [policy.burstWindowMs / 1000]);
      const burst = detectBurst(windowRows.rows.map(r => r.address), policy);
      if (burst.global || burst.domains.length > 0) {
        // the whole window's bounces in scope are suspect, not just this report's
        await client.query(`
          UPDATE email_bounces SET "senderSide" = true
          WHERE "createdAt" > now() - make_interval(secs => $1)
            AND ($2::boolean OR split_part(address, '@', 2) = ANY($3::text[]))
        `, [policy.burstWindowMs / 1000, burst.global, burst.domains]);
      }

      const candidates = failed.map(r => r.address).filter(a => !inBurst(a, burst));
      const history = new Map<string, Date[]>();
      if (candidates.length > 0) {
        const rows = await client.query<{ address: string, createdAt: Date }>(`
          SELECT address, "createdAt" FROM email_bounces
          WHERE address = ANY($1::text[]) AND NOT "senderSide"
        `, [candidates]);
        for (const row of rows.rows) {
          history.set(row.address, [...(history.get(row.address) ?? []), row.createdAt]);
        }
      }
      const unverify = addressesToUnverify(candidates, history, burst, policy);

      let usersUnverified = 0;
      let unverifiedUserIds: string[] = [];
      if (unverify.length > 0) {
        const updated = await client.query<{ id: string }>(`
          UPDATE users SET "emailVerified" = false
          WHERE lower(email) = ANY($1::text[]) AND "emailVerified" = true
          RETURNING "id"
        `, [unverify]);
        usersUnverified = updated.rowCount ?? 0;
        unverifiedUserIds = updated.rows.map(row => row.id);
      }

      await client.query('COMMIT');
      // these accounts need a verified address again (account-security step):
      // sessions that found them complete check again
      await bumpSecurityStepVersion(unverifiedUserIds);
      return { recorded: inserted.rowCount ?? 0, burst, unverify, usersUnverified };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** latest distinct diagnostics within the window, for the operator warning */
  public async recentDiagnostics(windowMs: number, limit = 3): Promise<string[]> {
    const result = await pool.query<{ diagnostic: string }>(`
      SELECT diagnostic FROM email_bounces
      WHERE "createdAt" > now() - make_interval(secs => $1) AND diagnostic IS NOT NULL
      GROUP BY diagnostic
      ORDER BY max("createdAt") DESC
      LIMIT $2
    `, [windowMs / 1000, limit]);
    return result.rows.map(r => r.diagnostic);
  }

  public async deleteExpired(): Promise<number> {
    const result = await pool.query(`
      DELETE FROM email_bounces WHERE "createdAt" < now() - make_interval(days => $1)
    `, [BOUNCE_RETENTION_DAYS]);
    return result.rowCount ?? 0;
  }
}

const emailBounceHelper = new EmailBounceHelper();
export default emailBounceHelper;
