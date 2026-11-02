// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { indicatorStateFor, isDelayedState, type IndicatorInput } from './indicatorState';

const base: IndicatorInput = {
  webSocketState: 'connected',
  serviceWorkerState: 'active',
  onlineState: 'online',
  initialGrace: false,
  everConnected: true,
  securityStepRequired: false,
};

describe('indicatorStateFor', () => {
  it('follows the real socket state', () => {
    expect(indicatorStateFor(base)).toBe('connected');
    expect(indicatorStateFor({ ...base, webSocketState: 'connecting' })).toBe('connecting');
    expect(indicatorStateFor({ ...base, webSocketState: 'disconnected' })).toBe('disconnected');
  });

  it('offline and the service-worker update win', () => {
    expect(indicatorStateFor({ ...base, onlineState: 'offline', serviceWorkerState: 'updated' })).toBe('offline');
    expect(indicatorStateFor({ ...base, serviceWorkerState: 'updated', webSocketState: 'disconnected' })).toBe('updated');
    expect(indicatorStateFor({ ...base, serviceWorkerState: 'updating' })).toBe('updating');
  });

  it('holds "Disconnected" back during the initial grace until the first live', () => {
    expect(indicatorStateFor({ ...base, webSocketState: 'disconnected', initialGrace: true, everConnected: false })).toBe('hidden');
    expect(indicatorStateFor({ ...base, webSocketState: 'disconnected', initialGrace: true, everConnected: true })).toBe('disconnected');
    expect(indicatorStateFor({ ...base, webSocketState: 'connecting', initialGrace: true, everConnected: false })).toBe('connecting');
  });

  it('a security-step account (never live) shows no connection problem', () => {
    expect(indicatorStateFor({ ...base, webSocketState: 'connecting', securityStepRequired: true })).toBe('hidden');
    expect(indicatorStateFor({ ...base, webSocketState: 'disconnected', securityStepRequired: true })).toBe('hidden');
  });

  it('only connecting/disconnected wait before they show', () => {
    expect(isDelayedState('connecting')).toBe(true);
    expect(isDelayedState('disconnected')).toBe(true);
    expect(isDelayedState('connected')).toBe(false);
    expect(isDelayedState('updated')).toBe(false);
  });
});
