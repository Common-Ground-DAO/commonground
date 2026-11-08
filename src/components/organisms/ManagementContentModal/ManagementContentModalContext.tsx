// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { createContext, useState } from "react";
import { useSearchParams } from "react-router";

type ManagementContentModalState = {
  activeModalContent: string | null;
  modalSearchParameter: string;
  lockModalOpen: boolean;
  setLockModalOpen: (state: boolean) => void;
}

export const ManagementContentModalContext = createContext<ManagementContentModalState>({
  activeModalContent: null,
  modalSearchParameter: '',
  lockModalOpen: false,
  setLockModalOpen: () => {}
});

export function ManagementContentModalProvider(props: React.PropsWithChildren<{ modalSearchParam?: string }>) {
  const [searchParams] = useSearchParams();
  const [lockModalOpen, setLockModalOpen] = useState(false);
  const active = searchParams.get(props.modalSearchParam || 'modal');

  return (
    <ManagementContentModalContext.Provider value={{
      activeModalContent: active,
      modalSearchParameter: props.modalSearchParam || 'modal',
      lockModalOpen,
      setLockModalOpen
    }}>
      {props.children}
    </ManagementContentModalContext.Provider>
  );
}

export function useManagementContentModalContext() {
  const context = React.useContext(ManagementContentModalContext);
  return context;
}

export const withManagementContentModalProvider = <P extends Object>(Component: React.FC<P>, modalSearchParam?: string): React.FC<P> =>
  React.memo(props => (
    <ManagementContentModalProvider modalSearchParam={modalSearchParam}>
      <Component {...props} />
    </ManagementContentModalProvider>
  ));
