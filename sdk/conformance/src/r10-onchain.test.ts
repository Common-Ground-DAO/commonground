/**
 * R10 — onchain (contracts, staking, points/premium, wallets, token roles).
 *
 * Contract: srv/api/contracts.ts (public), srv/api/staking.ts (login),
 * point/premium/wallet routes on User, role-claim routes on Community.
 *
 * The conformance instance runs with CG_ENABLE_BLOCKCHAIN=false, so this
 * suite pins the blockchain-disabled behavior the agent mapped: pure-DB reads
 * work (empty), the onchain-evaluated role check fails fast with
 * SERVICE_UNAVAILABLE, and staking config is null. The happy paths that need
 * a real indexed chain are out of reach here (documented, not skipped
 * silently).
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "@commonground/client";
import { MUTATIONS_ENABLED, registerUser, uniqueName } from "./fixtures.js";

const BLOCKCHAIN_DISABLED = process.env.CG_BLOCKCHAIN === "1" ? false : true;

describe.runIf(MUTATIONS_ENABLED)("Onchain", () => {
  it("getContractDataByIds is pure-DB and returns [] for unknown ids", async () => {
    const { client } = await registerUser("oc-contract");
    // Unknown (well-formed) uuids → empty, no error (works chain-disabled).
    const result = await client.contracts.getByIds(["00000000-0000-4000-8000-000000000000"]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("getContractData for an unknown contract is NOT_FOUND (fast, no hang)", async () => {
    const { client } = await registerUser("oc-cdata");
    await expect(
      client.contracts.getData("eth", "0x0000000000000000000000000000000000000000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("staking config is null when unconfigured; positions are empty", async () => {
    const { client } = await registerUser("oc-stake");
    const { config } = await client.staking.getConfig();
    expect(config).toBeNull();
    const positions = await client.staking.getPositions();
    expect(positions).toEqual([]);
  });

  it("staking endpoints require login", async () => {
    const anon = (await import("./fixtures.js")).newClient();
    await expect(anon.staking.getPositions()).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  });

  it("the Spark/point ledger reads (empty for a fresh account)", async () => {
    const { client } = await registerUser("oc-points");
    const ledger = await client.points.getLedger();
    expect(Array.isArray(ledger)).toBe(true);
  });

  it("buying premium with insufficient Spark is rejected", async () => {
    const { client } = await registerUser("oc-premium");
    // A fresh account has 0 pointBalance; the buy must fail (not silently pass).
    await expect(client.points.buyUserPremium("SUPPORTER_1", "month")).rejects.toBeInstanceOf(ApiError);
  });

  it("lists own wallets (empty for an email-only account)", async () => {
    const { client, session } = await registerUser("oc-wallet");
    const wallets = await client.wallets.list();
    expect(Array.isArray(wallets)).toBe(true);
    expect(wallets).toHaveLength(0);
    // Querying another user's wallets is NOT_ALLOWED.
    const { session: other } = await registerUser("oc-wallet-o");
    await expect(client.wallets.list(other.response.ownData.id)).rejects.toMatchObject({
      code: "NOT_ALLOWED",
    });
    void session;
  });

  it("a token-gated role: claimability fails fast when blockchain is disabled", async () => {
    const { client } = await registerUser("oc-role");
    const community = await client.communities.create({ title: uniqueName("oc-role") });
    // Register a (fake) contract reference isn't possible without the chain,
    // so just exercise the onchain-evaluated claimability endpoint: with the
    // blockchain service off it must fail fast rather than hang.
    if (BLOCKCHAIN_DISABLED) {
      await expect(client.communityAdmin.checkRoleClaimability(community.id)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
    } else {
      const result = await client.communityAdmin.checkRoleClaimability(community.id);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it("claiming a free auto-assign role works without any chain", async () => {
    const { client, session } = await registerUser("oc-free");
    const community = await client.communities.create({ title: uniqueName("oc-free") });
    // A free CUSTOM_AUTO_ASSIGN role is claimable with no onchain check.
    const { id: roleId } = await client.communityAdmin.createRole({
      communityId: community.id,
      title: uniqueName("free"),
      type: "CUSTOM_AUTO_ASSIGN",
      assignmentRules: { type: "free" },
      permissions: [],
    });
    const claimed = await client.communityAdmin.claimRole(community.id, roleId);
    expect(claimed).toBe(true);
    void session;
  });
});
