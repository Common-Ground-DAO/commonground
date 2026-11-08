// SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import localData from 'data/appstate/localData';
import './LocalDataRecovery.css';

export default function LocalDataRecovery() {
  const error = useSyncExternalStore(localData.subscribe, () => localData.error);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (error) button.current?.focus(); }, [error]);
  if (!error) return null;
  return createPortal(
    <div className="local-data-recovery" role="alertdialog" aria-modal="true"
      aria-labelledby="local-data-title" aria-describedby="local-data-description"
      onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); button.current?.focus(); } }}>
      <div>
        <h1 id="local-data-title">Please reload the app</h1>
        <p id="local-data-description">We couldn’t finish loading your data on this device. Reload to try again. You don’t need to clear your website data.</p>
        <button ref={button} onClick={() => window.location.reload()}>Reload</button>
      </div>
    </div>, document.body,
  );
}
