// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "common/config";
import React, { useEffect, useLayoutEffect } from "react";
import { useParams } from "react-router-dom";

const allEcosystems = ['cg', 'fuel', 'lukso', 'powershift', 'cannabis-social-clubs', 'si3'] as const;
export type EcosystemType = typeof allEcosystems[number];

const stagingEcosystems: EcosystemType[] = ['fuel', 'lukso','si3', 'cannabis-social-clubs', 'powershift'];
const prodEcosystems: EcosystemType[] = ['fuel', 'lukso','si3', 'cannabis-social-clubs', 'powershift'];
export let ecosystems: EcosystemType[];

if (config.DEPLOYMENT === 'prod') {
  ecosystems = prodEcosystems;
} else {
  ecosystems = stagingEcosystems;
}

type EcosystemContextState = {
  ecosystem: EcosystemType | null;
  setEcosystem: (ecosystemType: EcosystemType | null) => void
}

export const EcosystemProviderContext = React.createContext<EcosystemContextState>({
  ecosystem: null,
  setEcosystem: () => {},
});

export function EcosystemProvider(props: React.PropsWithChildren) {
  const [ecosystem, setEcosystem] = React.useState<EcosystemType | null>(null);

  useEffect(() => {
    document.body.style.removeProperty('--text-highlight');
    document.body.style.removeProperty('--border-highlight');
    document.body.style.removeProperty('--surface-buttons-primary');
    document.body.style.removeProperty('--surface-buttons-primary-hover');
    document.body.style.removeProperty('--surface-buttons-primary-active');
    document.body.style.removeProperty('--surface-buttons-text-primary');
    document.body.style.removeProperty('--text-button-primary');
    document.body.style.removeProperty('--surface-buttons-text-primary-active');
    document.body.style.removeProperty('--btnPrimaryBoxShadow');
    document.body.style.removeProperty('--btnPrimaryActiveBoxShadow');
    document.body.style.removeProperty('--surface-subtleoverlay-eco');
    document.body.style.removeProperty('--text-primary-eco');
  }, [ecosystem]);

  return (
    <EcosystemProviderContext.Provider value={{ ecosystem: ecosystem , setEcosystem }}>
      {props.children}
    </EcosystemProviderContext.Provider>
  );
}

export function EcosystemParamSetter(props: React.PropsWithChildren) {
  const { ecosystem, setEcosystem } = useEcosystemContext();
  const { ecosystem: paramEcosystem } = useParams<'ecosystem'>();

  useLayoutEffect(() => {
    if (ecosystem !== paramEcosystem) {
      setEcosystem(paramEcosystem as EcosystemType);
    }
  }, [ecosystem, paramEcosystem, setEcosystem]);

  return <>{props.children}</>;
}

export function useEcosystemContext() {
  const context = React.useContext(EcosystemProviderContext);
  return context;
}