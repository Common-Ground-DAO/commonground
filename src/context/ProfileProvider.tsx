// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from "react";
import { useParams } from "react-router";
import { parseIdOrUrl } from "../util";
import { useOwnUser } from "./OwnDataProvider";
import { useUserData } from "./UserDataProvider";

type ProfileState = {
  state: 'loaded';
  user: Models.User.Data;
  isSelf: boolean;
} | { state: "loading" } | { state: "no-user" };

export const ProfileContext = React.createContext<ProfileState>({ state: "no-user" });

export function ProfileProvider(props: React.PropsWithChildren) {
  const { idOrUrl } = useParams<'idOrUrl'>();
  const ownUser = useOwnUser();

  const parsed = useMemo(() => {
    if (idOrUrl) return parseIdOrUrl(idOrUrl);
  }, [idOrUrl]);

  const replyOwnUser = !!ownUser && parsed?.uuid === ownUser.id;
  const userData = useUserData(!!parsed && !replyOwnUser ? parsed.uuid : undefined);
  const user = useMemo(() => {
    if (replyOwnUser) {
      return {
        ...ownUser,
        isFollowed: false,
        isFollower: false,
      };
    }
    else {
      return userData;
    }
  }, [replyOwnUser, ownUser, userData]);

  let value: ProfileState = React.useMemo(() => {
    if (user) {
      return {
        state: 'loaded',
        user,
        isSelf: user.id === ownUser?.id
      };
    } else {
      return { state: "loading" };
    }
  }, [ownUser?.id, user]);

  return (
    <ProfileContext.Provider value={value}>
      {props.children}
    </ProfileContext.Provider>
  );
}

export function useSafeProfileContext() {
  const context = React.useContext(ProfileContext);
  return context;
}

export function useLoadedProfileContext() {
  const context = React.useContext(ProfileContext);
  if (context.state !== "loaded") {
    console.error("No user loaded. Use the safe version of this function or handle this error.");
    throw new Error();
  }
  return context;
}