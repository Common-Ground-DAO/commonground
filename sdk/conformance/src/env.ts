/**
 * Conformance suite environment.
 *
 * CG_BASE_URL selects the instance under test. Defaults to the local
 * disposable stack the bootstrap script starts (tools/run-local-instance.sh);
 * point it at any live instance (e.g. https://cg.mogged.eu) to run against
 * that instead.
 */

export const BASE_URL = (process.env.CG_BASE_URL ?? "https://localhost:8443").replace(/\/+$/, "");

/**
 * Marker prefix for accounts/objects the suite creates, so operators can
 * recognize and purge conformance fixtures on a shared instance.
 */
export const FIXTURE_PREFIX = "sdk-conformance-";
