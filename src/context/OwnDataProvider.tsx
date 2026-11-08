// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from "react";
import { useLiveQuery } from 'dexie-react-hooks';
import data from "data";
import errors from "common/errors";
import { useNavigate } from "react-router";
import { getUrl } from 'common/util';

type OwnDataState = {
  ownUser?: Models.User.OwnData;
  ownWallets?: Models.Wallet.Wallet[];
  ownCommunities: Models.Community.DetailView[];
  chats: Models.Chat.Chat[];
  navigateToChatOrCreateNewChat: (userId: string) => Promise<void>;
}

export const OwnDataContext = React.createContext<OwnDataState>({
  ownCommunities: [],
  chats: [],
  navigateToChatOrCreateNewChat: () => Promise.resolve(),
});

export function OwnDataProvider(props: React.PropsWithChildren) {
  const navigate = useNavigate();

  const ownUser = useLiveQuery(() => {
    return data.user.getOwnData();
  }, []);

  const ownCommunities = useLiveQuery(() => {
    return data.community.getOwnCommunities();
  }, []);

  const ownWallets = useLiveQuery(() => {
    return data.user.getOwnWallets();
  }, [])

  const sortedCommunities = useMemo(() => {
    if (!!ownCommunities && ownCommunities.length > 0) {
      if (!!ownUser) {
        const consumable = [...ownCommunities];
        const result: Models.Community.DetailView[] = [];
        for (const id of ownUser.communityOrder) {
          const index = consumable.findIndex(c => c.id === id);
          if (index >= 0) {
            result.push(consumable.splice(index, 1)[0]);
          } else {
            console.warn(`CommunityId "${id}" from ownData.communityOrder could not be found in ownCommunities (or existed twice)`);
          }
        }
        if (consumable.length > 0) {
          console.warn(`There are ${consumable.length} "leftover" ownCommunities which do not appear in ownData.communityOrder, adding them to the end of the list`);
          result.push(...consumable);
        }
        return result;
      } else {
        console.warn(`ownCommunities exist, but ownData is undefined - this can either be an error or a race condition`);
      }
    } 
    return [];
  }, [!!ownUser ? ownUser.communityOrder : null, ownCommunities]);

  const chatsFromDb = useLiveQuery(() => {
    return data.chats.getAllChats();
  });

  const chats = useMemo(() => {
    if (!chatsFromDb) {
      return undefined;
    }
    return [...chatsFromDb].sort((a, b) => {
      const aCreated = new Date(!!a.lastMessage ? a.lastMessage.createdAt : a.createdAt);
      const bCreated = new Date(!!b.lastMessage ? b.lastMessage.createdAt : b.createdAt);
      return bCreated.getTime() - aCreated.getTime();
    });
  }, [chatsFromDb]);

  const navigateToChatOrCreateNewChat = useCallback(async (userId: string) => {
    if (!!chats) {
      const chat = chats.find(chat => chat.userIds.includes(userId));
      if (!!chat) {
        navigate(getUrl({
          type: "chat",
          chat
        }));
      }
      else {
        const chat = await data.chats.createChat(userId);
        setTimeout(() => {
          navigate(getUrl({
            type: "chat",
            chat,
          }));
        }, 200);
      }
    }
  }, [chats, navigate]);

  return (
    <OwnDataContext.Provider value={{
      ownUser,
      ownWallets,
      ownCommunities: sortedCommunities,
      chats: chats || [],
      navigateToChatOrCreateNewChat,
    }}>
      {props.children}
    </OwnDataContext.Provider>
  )
}

export function useOwnUser() {
  const context = React.useContext(OwnDataContext);
  return context.ownUser;
}

export function useOwnWallets() {
  const context = React.useContext(OwnDataContext);
  return context.ownWallets;
}

export function useLoggedInOwnUser() {
  const context = React.useContext(OwnDataContext);
  if (!context.ownUser) {
    console.error("User needs to be logged in to use this context, consider falling back to useOwnContext");
    throw new Error(errors.client.LOGIN_REQUIRED);
  }
  return context.ownUser;
}

export function useOwnCommunities() {
  const context = React.useContext(OwnDataContext);
  return context.ownCommunities;
}

export function useChats() {
  const context = React.useContext(OwnDataContext);
  return {
    chats: context.chats,
    navigateToChatOrCreateNewChat: context.navigateToChatOrCreateNewChat,
  };
}