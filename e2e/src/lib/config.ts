// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/** Command line of the suite (src/main.ts); e2e/run.sh passes it through. */

/** the reload flow's modes (src/flows/03-reload.ts) */
export const RELOAD_MODES = ['natural', 'reordered', 'interrupted', 'cookie-cleared', 'session-expired', 'force-reload-cold-sw'] as const;
export type ReloadMode = typeof RELOAD_MODES[number];

export type Config = {
  /** the instance under test, e.g. https://cg-e2e.test (no trailing slash) */
  baseUrl: string;
  /** PEM file with the CA that issued the instance's certificate */
  caFile?: string;
  /** extra SPKI pins (base64 sha256 of a leaf certificate's public key) Chrome should accept */
  spki: string[];
  /** Mailpit base URL (e.g. http://mailpit:8025); without it, flows that need a mailed code skip */
  mailpitUrl?: string;
  /** the instance's gateway (its old domain in gateway mode), e.g. https://app.cg-e2e.test; without it the gateway flow skips */
  gatewayUrl?: string;
  /** flow ids to run (empty = all) */
  flows: string[];
  /** where report.json and screenshots go */
  outDir: string;
  /** reload iterations of the reload-robustness flow */
  reloadIterations: number;
  /** modes of the reload flow, validated (empty = all available) */
  reloadModes: ReloadMode[];
  /**
   * the instance's session store (redis://:password@host:port) for the
   * session-expired reload mode — from the environment (E2E_REDIS_URL), never
   * the command line, so the password does not show up in process lists
   */
  redisUrl?: string;
  /** screenshot after every step, not only on failure */
  screenshotSteps: boolean;
  /** per-flow timeout */
  flowTimeoutMs: number;
  /** Chrome --host-resolver-rules entries ("host=ip") */
  resolve: string[];
  /** only list the flows */
  list: boolean;
  /** slow everything down by this many ms per puppeteer action (debugging) */
  slowMo: number;
};

const USAGE = `Usage: node src/main.ts --url <https://instance> [options]

  --url <url>             instance under test (required)
  --ca <file>             PEM root CA of the instance's certificate (self-host "tls internal")
  --spki <hash>           extra leaf-key pin (base64 sha256 of the SPKI) to accept; repeatable
  --mailpit <url>         Mailpit API base URL, enables the mailed-code variants
  --gateway-url <url>     the instance's gateway (old domain), enables the gateway flow
  --flow <id>[,<id>]      run only these flows or groups (repeatable; chat-sync = E1–E8);
                          --list shows the ids and groups
  --out <dir>             output directory (default: ./results/<timestamp>)
  --reload-iterations <n> iterations of the reload flow (default 20)
  --reload-modes <m,...>  reload modes to rotate through: ${RELOAD_MODES.join(', ')}
                          (default: all available; session-expired needs E2E_REDIS_URL)
  --screenshots           screenshot after every step, not only on failure
  --flow-timeout <s>      per-flow timeout in seconds (default 240)
  --resolve <host>=<ip>   resolve a host name to a fixed address in Chrome; repeatable
  --slow-mo <ms>          slow down every browser action (debugging)
  --list                  list the flows and exit

Environment:
  E2E_REDIS_URL           the instance's Valkey (redis://:password@host:port) for the
                          session-expired reload mode (e2e/run.sh --instance sets it)
`;

function positiveInt(option: string, raw: string, min = 1): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${option} needs an integer >= ${min}, got "${raw}"\n\n${USAGE}`);
  }
  return n;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    baseUrl: '',
    spki: [],
    flows: [],
    outDir: '',
    reloadIterations: 20,
    reloadModes: [],
    redisUrl: env.E2E_REDIS_URL || undefined,
    screenshotSteps: false,
    flowTimeoutMs: 240_000,
    resolve: [],
    list: false,
    slowMo: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`${arg} needs a value\n\n${USAGE}`);
      }
      return v;
    };
    switch (arg) {
      case '--url': config.baseUrl = value().replace(/\/+$/, ''); break;
      case '--ca': config.caFile = value(); break;
      case '--spki': config.spki.push(value()); break;
      case '--mailpit': config.mailpitUrl = value().replace(/\/+$/, ''); break;
      case '--gateway-url': config.gatewayUrl = value().replace(/\/+$/, ''); break;
      case '--flow': config.flows.push(...value().split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--out': config.outDir = value(); break;
      case '--reload-iterations': config.reloadIterations = positiveInt(arg, value()); break;
      case '--reload-modes': {
        for (const mode of value().split(',').map(m => m.trim()).filter(Boolean)) {
          if (!(RELOAD_MODES as readonly string[]).includes(mode)) {
            throw new Error(`unknown reload mode "${mode}" (known: ${RELOAD_MODES.join(', ')})`);
          }
          config.reloadModes.push(mode as ReloadMode);
        }
        break;
      }
      case '--screenshots': config.screenshotSteps = true; break;
      case '--flow-timeout': config.flowTimeoutMs = positiveInt(arg, value()) * 1000; break;
      case '--resolve': {
        const rule = value();
        if (!/^[^=\s]+=[^=\s]+$/.test(rule)) {
          throw new Error(`--resolve needs host=ip, got "${rule}"`);
        }
        config.resolve.push(rule);
        break;
      }
      case '--slow-mo': config.slowMo = positiveInt(arg, value(), 0); break;
      case '--list': config.list = true; break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${arg}\n\n${USAGE}`);
    }
  }
  if (!config.list && !config.baseUrl) {
    throw new Error(`--url is required\n\n${USAGE}`);
  }
  if (config.baseUrl && !/^https?:\/\/[^/]+$/.test(config.baseUrl)) {
    throw new Error(`--url must be an origin like https://host[:port], got "${config.baseUrl}"`);
  }
  if (config.gatewayUrl && !/^https?:\/\/[^/]+$/.test(config.gatewayUrl)) {
    throw new Error(`--gateway-url must be an origin like https://host[:port], got "${config.gatewayUrl}"`);
  }
  if (config.redisUrl && !/^rediss?:\/\//.test(config.redisUrl)) {
    throw new Error('E2E_REDIS_URL must be a redis:// URL');
  }
  if (config.reloadModes.includes('session-expired') && !config.redisUrl) {
    throw new Error('the session-expired reload mode needs E2E_REDIS_URL (the instance\'s Valkey); e2e/run.sh --instance sets it');
  }
  if (!config.outDir) {
    config.outDir = `results/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  return config;
}
