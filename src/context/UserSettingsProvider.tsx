// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { allPageTypes, PageType } from "components/organisms/UserSettingsModalContent/UserSettingsModalContent";
import React, { useState } from "react";
import { useSearchParams } from "react-router";

type UserSettingsContextState = {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  currentPage: PageType;
  setCurrentPage: (page: PageType) => void;

  giveSparkCommunityId: string;
  setGiveSparkCommunityId: (id: string) => void;
};

export const UserSettingsContext = React.createContext<UserSettingsContextState>({
  isOpen: false,
  setIsOpen: () => {},
  currentPage: 'home',
  setCurrentPage: () => {},

  giveSparkCommunityId: '',
  setGiveSparkCommunityId: () => {}
});

export function UserSettingsProvider(props: React.PropsWithChildren<{}>) {
  const [searchParams] = useSearchParams();
  const searchSettings = searchParams.get('user-settings');

  const [isOpen, setIsOpen] = useState(allPageTypes.includes(searchSettings as any));
  const [currentPage, setCurrentPage] = useState<PageType>(allPageTypes.includes(searchSettings as any) ? searchSettings as any : 'home');
  const [giveSparkCommunityId, setGiveSparkCommunityId] = useState<string>('');

  return (
    <UserSettingsContext.Provider value={{ isOpen, setIsOpen, currentPage, setCurrentPage, giveSparkCommunityId, setGiveSparkCommunityId }}>
      {props.children}
    </UserSettingsContext.Provider>
  )
}

export function useUserSettingsContext() {
  const context = React.useContext(UserSettingsContext);
  return context;
}