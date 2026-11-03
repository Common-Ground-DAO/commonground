// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import { installBrowserEnv } from 'test/env';
import { importAsNewTab } from 'test/modules';

const KEY = 'CG_KNOWN_INDEXEDDBS';
const info = { createdInAppVersion: '1.0.0', createdAtTime: 1 };

/** a tab whose dbTracker knows `names` */
async function tabWith(names: string[]) {
  const env = installBrowserEnv();
  const known = Object.fromEntries(names.map(n => [n, info]));
  localStorage.setItem(KEY, JSON.stringify(known));
  const { default: dbTracker } = await importAsNewTab(() => import('./dbTracker'));
  return { env, dbTracker, known };
}

describe('dbTracker storage listener', () => {
  it('drops an obsolete database another tab forgot', async () => {
    const { env, dbTracker, known } = await tabWith(['commonGroundDB_chunked_databases', 'commonGroundDB_users']);
    const { commonGroundDB_chunked_databases: _gone, ...rest } = known;
    env.storageEvent({ key: KEY, oldValue: JSON.stringify(known), newValue: JSON.stringify(rest) });
    expect(dbTracker.knownDatabaseNames()).toEqual(['commonGroundDB_users']);
  });

  it('keeps a live database missing from the new value (racing registerDatabase) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env, dbTracker, known } = await tabWith(['commonGroundDB_communities', 'commonGroundDB_users']);
    const { commonGroundDB_communities: _lost, ...rest } = known;
    env.storageEvent({ key: KEY, oldValue: JSON.stringify(known), newValue: JSON.stringify(rest) });
    expect(dbTracker.knownDatabaseNames().sort()).toEqual(['commonGroundDB_communities', 'commonGroundDB_users']);
    expect(warn).toHaveBeenCalled();
    // the next write of this tab puts it back
    dbTracker.forgetDatabase('commonGroundDB_unknown');
    dbTracker.registerDatabase('commonGroundDB_chat');
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!)).sort())
      .toEqual(['commonGroundDB_chat', 'commonGroundDB_communities', 'commonGroundDB_users']);
    warn.mockRestore();
  });

  it('forgetDatabase removes a name from memory and localStorage', async () => {
    const { dbTracker } = await tabWith(['commonGroundDB_messages', 'commonGroundDB_users']);
    dbTracker.forgetDatabase('commonGroundDB_messages');
    expect(dbTracker.knownDatabaseNames()).toEqual(['commonGroundDB_users']);
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toEqual(['commonGroundDB_users']);
  });
});
