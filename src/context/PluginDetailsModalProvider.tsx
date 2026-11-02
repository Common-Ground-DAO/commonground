// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from "react";
import PluginCardDetails from "components/organisms/PluginAppstore/PluginCardDetails";
import { useLocation } from "react-router";

type PluginDetailsModalProps = {
  plugin: Models.Plugin.PluginListView;
};

type PluginDetailsModalState = {
  showModal: (data: PluginDetailsModalProps) => void;
  closeModal: () => void;
};

export const PluginDetailsModalContext = React.createContext<PluginDetailsModalState>({
  showModal: () => { },
  closeModal: () => { },
});

export function PluginDetailsModalProvider(props: React.PropsWithChildren<{}>) {
  const [modalData, setModalData] = useState<PluginDetailsModalProps | null>(null);
  const { pathname } = useLocation();
  
  const showModal = useCallback((data: PluginDetailsModalProps) => {
    setModalData(data);
  }, []);

  const closeModal = useCallback(() => {
    setModalData(null);
  }, []);

  useEffect(() => {
    // Close modal when navigating to a new page
    closeModal();
  }, [closeModal, pathname]);

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && modalData) {
        closeModal();
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => {
      document.removeEventListener('keydown', handleKeyPress);
    };
  }, [closeModal, modalData]);

  return (
    <PluginDetailsModalContext.Provider value={{ showModal, closeModal }}>
      {props.children}
      {modalData && (
        <PluginCardDetails
          isOpen={!!modalData}
          onClose={closeModal}
          plugin={modalData.plugin}
        />
      )}
    </PluginDetailsModalContext.Provider>
  );
}

export function usePluginDetailsModalContext() {
  const context = React.useContext(PluginDetailsModalContext);
  return context;
}