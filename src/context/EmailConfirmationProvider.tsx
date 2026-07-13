// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import CommunityJoinedModal from "components/organisms/CommunityJoinedModal/CommunityJoinedModal";
import EmailConfirmationModal, { EmailConfirmationModalState } from "components/organisms/EmailConfirmationModal/EmailConfirmationModal";
import config from "common/config";
import { useOwnUser } from "context/OwnDataProvider";
import data from "data";
import { useLiveQuery } from "dexie-react-hooks";
import React, { useCallback, useEffect, useState } from "react";

type EmailConfirmationContextState = {
  openModal: (state: EmailConfirmationModalState) => void;
  close: () => void;
};

export const EmailConfirmationContext = React.createContext<EmailConfirmationContextState>({
  openModal: () => { },
  close: () => { }
});

export function EmailConfirmationProvider(props: React.PropsWithChildren<{}>) {
  const [isModalOpen, setModalOpen] = useState(false);
  const [modalState, setModalState] = useState<EmailConfirmationModalState>('signup');
  const user = useOwnUser();

  useEffect(() => {
    if (modalState === "pending") {
      if (user?.emailVerified) {
        setModalState("confirmed");
      }
    }
  }, [user?.emailVerified, modalState]);

  const openModal = useCallback((state: EmailConfirmationModalState) => {
    if (!config.EMAIL_ENABLED) {
      // verification mails can never arrive on this instance — don't ask
      return;
    }
    setModalState(state);
    setModalOpen(true);
  }, []);

  const close = useCallback(() => setModalOpen(false), []);

  return (
    <EmailConfirmationContext.Provider value={{
      openModal,
      close
    }}>
      {!!isModalOpen && <EmailConfirmationModal
        onClose={() => setModalOpen(false)}
        modalState={modalState}
        setModalState={setModalState}
        userEmail={user?.email ?? ""}
      />}
      {props.children}
    </EmailConfirmationContext.Provider>
  )
}

export function useEmailConfirmationContext() {
  const context = React.useContext(EmailConfirmationContext);
  return context;
}