// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useState } from "react";
import { useLocation } from "react-router";
import ExternalLinkModal from "components/molecules/ExternalLinkModal/ExternalLinkModal";

type MobileUserTooltipState = {
  showModal: (url: string) => void;
}

export const ExternalModalContext = React.createContext<MobileUserTooltipState>({
  showModal: () => { },
});

export function ExternalModalProvider(props: React.PropsWithChildren<{}>) {
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    // Close slider when navigating to a new page
    setExternalUrl(null);
  }, [pathname]);

  return (
    <ExternalModalContext.Provider value={{ showModal: setExternalUrl }}>
      {props.children}
      <ExternalLinkModal
        isVisible={!!externalUrl}
        onClose={() => setExternalUrl(null)}
        url={externalUrl || ''}
      />
    </ExternalModalContext.Provider>
  )
}

export function useExternalModalContext() {
  const context = React.useContext(ExternalModalContext);
  return context;
}