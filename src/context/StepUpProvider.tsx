// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReauthDialog from 'components/organisms/ReauthDialog/ReauthDialog';
import stepUpManager, { type StepUpRequest } from 'data/auth/stepUp';

/**
 * Hosts the "Confirm it's you" dialog (docs/auth-identity §8). It registers
 * itself with `stepUpManager`, which `BaseApiConnector` calls on
 * REAUTH_REQUIRED (the request is retried once after a confirmation), and
 * offers `ensureRecentAuth` to screens that must confirm BEFORE starting a
 * ceremony of their own (adding a passkey needs a click of its own).
 */

export type StepUpResult = 'fresh' | 'reauthenticated' | 'cancelled';

type StepUpState = {
  ensureRecentAuth: (action: string, options?: { allowWallet?: boolean }) => Promise<StepUpResult>;
};

const StepUpContext = React.createContext<StepUpState>({
  ensureRecentAuth: async () => 'cancelled',
});

export function StepUpProvider(props: React.PropsWithChildren<{}>) {
  const [pending, setPending] = useState<{ id: number; request: StepUpRequest; resolve: (confirmed: boolean) => void } | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    stepUpManager.setHandler(request => new Promise<boolean>(resolve => {
      setPending({ id: ++nextId.current, request, resolve });
    }));
    return () => {
      stepUpManager.setHandler(undefined);
    };
  }, []);

  // each dialog answers only its own request
  const finish = useCallback((id: number, confirmed: boolean) => {
    setPending(current => (current?.id === id ? null : current));
    if (pending?.id === id) {
      pending.resolve(confirmed);
    }
  }, [pending]);

  const ensureRecentAuth = useCallback<StepUpState['ensureRecentAuth']>(async (action, options) => {
    if (stepUpManager.isFresh()) {
      return 'fresh';
    }
    const confirmed = await stepUpManager.request({ action, allowWallet: options?.allowWallet ?? true });
    return confirmed ? 'reauthenticated' : 'cancelled';
  }, []);

  const value = useMemo(() => ({ ensureRecentAuth }), [ensureRecentAuth]);

  return (
    <StepUpContext.Provider value={value}>
      {props.children}
      {!!pending && <ReauthDialog key={pending.id} request={pending.request} onDone={confirmed => finish(pending.id, confirmed)} />}
    </StepUpContext.Provider>
  );
}

export function useStepUp() {
  return React.useContext(StepUpContext);
}
