// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from "react";
import Modal from "../components/atoms/Modal/Modal";
import { useSafeCommunityContext } from "./CommunityProvider";

import CloseIcon from '../components/atoms/icons/16/Close.svg?react';
import BinIcon from '../components/atoms/icons/16/Bin.svg?react';
import VolumeMuteIcon from "../components/atoms/icons/24/VolumeMuteIcon.svg?react";
import LightningIcon from "../components/atoms/icons/24/LightningIcon.svg?react";

import Button from "../components/atoms/Button/Button";
import messageApi from "data/api/messages";
import CheckboxBase from "components/atoms/CheckboxBase/CheckboxBase";
import data from "data";
import { useOwnUser } from "./OwnDataProvider";
import communityApi from "data/api/community";
import { UserBlockState } from "common/enums";

const getDurationFromOptions = (selectedValue: Common.Content.DurationOption) => {
  switch (selectedValue) {
    case "permanently":
      return undefined;
    case "15m":
      return convertDurationToSeconds(15, "minutes");
    case "1h":
      return convertDurationToSeconds(1, "hours");
    case "1d":
      return convertDurationToSeconds(1, "days");
    case "1w":
      return convertDurationToSeconds(1, "weeks");
  }
}

const convertDurationToSeconds = (value: number, convertFrom: "minutes" | "hours" | "days" | "weeks"): number => {
  switch (convertFrom) {
    case 'minutes':
      return value * 60;
    case 'hours':
      return value * 60 * 60;
    case 'days':
      return value * 24 * 60 * 60;
    case 'weeks':
      return value * 7 * 24 * 60 * 60;
    default:
      throw new Error("Invalid duration unit")
  }
}

type CommunityModerationState = {
  deleteMessage: (messageId: string, creatorId: string, channelId: string) => void;
  warnUser: (reason: Common.Content.WarnReason, userId: string, channelId: string) => void;
  muteUser: (duration: Common.Content.DurationOption, userId: string, channelId: string) => void;
  banUser: (duration: Common.Content.DurationOption, userId: string, channelId?: string) => void;
  
}

export const CommunityModerationContext = React.createContext<CommunityModerationState>({
  deleteMessage: () => undefined,
  warnUser: () => undefined,
  muteUser: () => undefined,
  banUser: () => undefined,
});

export function CommunityModerationProvider(props: React.PropsWithChildren) {
  const communityState = useSafeCommunityContext();
  const ownUser = useOwnUser();

  const [deleteMessageData, setDeleteMessageData] = useState<{
    messageId: string;
    creatorId: string;
    channelId: string;
  } | undefined>();

  const [warnUserData, setWarnUserData] = useState<{
    reason: Common.Content.WarnReason;
    userId: string;
    channelId: string;
  } | undefined>();

  const [muteUserData, setMuteUserData] = useState<{
    duration: Common.Content.DurationOption;
    userId: string;
    channelId: string;
  } | undefined>();

  const [banUserData, setBanUserData] = useState<{
    duration: Common.Content.DurationOption;
    userId: string;
    channelId?: string;
  } | undefined>();

  const [checkboxRemoveAllUserPosts, setCheckboxRemoveAllUserPosts] = useState<boolean>(false);

  const deleteMessage = useCallback((messageId: string, creatorId: string, channelId: string) => {
    setDeleteMessageData({ messageId, creatorId, channelId });
  }, []);

  const warnUser = useCallback((reason: Common.Content.WarnReason, userId: string, channelId: string) => {
    setWarnUserData({ reason, userId, channelId });
  }, []);

  const muteUser = useCallback((duration: Common.Content.DurationOption, userId: string, channelId: string) => {
    setMuteUserData({ duration, userId, channelId });
  }, []);

  const banUser = useCallback((duration: Common.Content.DurationOption, userId: string, channelId?: string) => {
    setBanUserData({ duration, userId, channelId });
  }, []);

  const handleDeleteMessageConfirm = useCallback(async (ev: React.MouseEvent) => {
    if (!!deleteMessageData && communityState.state === "loaded") {
      const access = {
        communityId: communityState.community.id,
        channelId: deleteMessageData.channelId,
      };
      if (checkboxRemoveAllUserPosts) {
        await messageApi.deleteAllUserMessages({
          creatorId: deleteMessageData.creatorId,
          access,
        });
      } else {
        await messageApi.deleteMessage({
          creatorId: deleteMessageData.creatorId,
          messageId: deleteMessageData.messageId,
          access,
        });
      }
    }
    setDeleteMessageData(undefined);
    setCheckboxRemoveAllUserPosts(false);
  }, [checkboxRemoveAllUserPosts, communityState, deleteMessageData]);

  const handleWarnConfirm = useCallback(async (ev: React.MouseEvent) => {
    if (!!warnUserData && communityState.state === "loaded") {
      // FIXME:
      console.warn("Todo: Warning messages not accepted by api yet, this should fail at the moment");
      const access = {
        communityId: communityState.community.id,
        channelId: warnUserData.channelId,
      };
      await data.channelManager.createMessage({
        attachments: [],
        body: {
          version: "1",
          content: [{
            type: "special",
            action: "warn",
            userId: warnUserData.userId,
            reason: warnUserData.reason,
          }]
        },
        parentMessageId: null,
        channelId: access.channelId,
        creatorId: ownUser?.id || "",
      }, true);
      setWarnUserData(undefined);
    }
  }, [communityState, warnUserData]);

  const handleMuteConfirm = useCallback(async (ev: React.MouseEvent) => {
    if (!!muteUserData && communityState.state === "loaded") {
      console.warn("Todo: Muting not accepted by api yet, this should fail at the moment");
      const access = {
        communityId: communityState.community.id,
        channelId: muteUserData.channelId,
      };
      // FIXME:
      // Todo!
      // const duration = getDurationFromOptions(muteUserData.duration);
      // await communityApi.muteOrBanUser(...);
      await data.channelManager.createMessage({
        attachments: [],
        body: {
          version: "1",
          content: [{
            type: "special",
            action: "mute",
            duration: muteUserData.duration,
            userId: muteUserData.userId,
          }]
        },
        parentMessageId: null,
        channelId: access.channelId,
        creatorId: ownUser?.id || "",
      }, true);
      const duration = getDurationFromOptions(muteUserData.duration);
      await communityApi.setUserBlockState({
        communityId: communityState.community.id,
        userId: muteUserData.userId,
        blockState: UserBlockState.CHAT_MUTED,
        until: duration === undefined ? null : new Date(Date.now() + (duration * 1000)).toISOString(),
      });
      setMuteUserData(undefined);
    }
  }, [communityState, muteUserData]);

  const handleBanConfirm = useCallback(async (ev: React.MouseEvent) => {
    if (!!banUserData && communityState.state === "loaded") {
      console.warn("Todo: Banning not accepted by api yet, this should fail at the moment");
      const { channelId } = banUserData;
      // FIXME:
      // Todo!
      // const duration = getDurationFromOptions(banUserData.duration);
      // await communityApi.muteOrBanUser(...);
      if (checkboxRemoveAllUserPosts) {
        await Promise.all([
          communityState.channels.map(c => 
            messageApi.deleteAllUserMessages({
              creatorId: banUserData.userId,
              access: {
                communityId: communityState.community.id,
                channelId: c.channelId,
              },
            })
          )
        ]);
      }
      if (!!channelId) {
        const access = {
          communityId: communityState.community.id,
          channelId,
        };
        await data.channelManager.createMessage({
          attachments: [],
          body: {
            version: "1",
            content: [{
              type: "special",
              action: "banned",
              duration: banUserData.duration,
              userId: banUserData.userId,
            }]
          },
          parentMessageId: null,
          channelId: access.channelId,
          creatorId: ownUser?.id || "",
        }, true);
      }
      const duration = getDurationFromOptions(banUserData.duration);
      await communityApi.setUserBlockState({
        communityId: communityState.community.id,
        userId: banUserData.userId,
        blockState: UserBlockState.BANNED,
        until: duration === undefined ? null : new Date(Date.now() + (duration * 1000)).toISOString(),
      });
      setBanUserData(undefined);
      setCheckboxRemoveAllUserPosts(false);
    }
  }, [banUserData, communityState, checkboxRemoveAllUserPosts]);

  const onCheckboxChange = useCallback((checked: boolean) => {
    setCheckboxRemoveAllUserPosts(checked);
  }, [setCheckboxRemoveAllUserPosts]);

  const modals = (
    <>
      {!!deleteMessageData && (
        <Modal headerText="Delete message" close={() => setDeleteMessageData(undefined)}>
          <div className="modal-inner">
            <p>Are you sure you want to delete this message for all users?</p>
              <div className="flex flex-row items-center gap-2 mt-1" onClick={() => onCheckboxChange(!checkboxRemoveAllUserPosts)}>
                <CheckboxBase type="checkbox" size="normal" checked={!!checkboxRemoveAllUserPosts} /> 
                <p className="flex-1">Also delete all other messages in this channel by this user</p>
              </div>
            <div className="btnList justify-end gap-4 mt-4">
              <Button
                text="Cancel"
                onClick={(ev) => { ev.stopPropagation(); setDeleteMessageData(undefined); }}
                role="secondary"
              />
              <Button
                text="Delete"
                iconLeft={<BinIcon />}
                onClick={handleDeleteMessageConfirm}
                role="primary"
              />
            </div>
          </div>
        </Modal>
      )}
      {!!warnUserData && (
        <Modal headerText="Warn" close={() => setWarnUserData(undefined)}>
          <div className="modal-inner">
            <p>Are you sure you want to send a warning to this user? They will receive a notification to mind their manners.</p>
            <div className="btnList justify-end gap-4 mt-4">
              <Button
                text="Cancel"
                onClick={(ev) => { ev.stopPropagation(); setWarnUserData(undefined); }}
                role="secondary"
              />
              <Button
                text="Warn"
                iconLeft={<LightningIcon />}
                onClick={handleWarnConfirm}
                role="primary"
              />
            </div>
          </div>
        </Modal>
      )}
      {!!muteUserData && (
        <Modal headerText="Mute" close={() => setMuteUserData(undefined)}>
          <div className="modal-inner">
            <p>Are you sure you want to mute this user {muteUserData.duration === "permanently" ? "" : "for"} {muteUserData.duration}?</p>
            <div className="btnList justify-end gap-4 mt-4">
              <Button
                text="Cancel"
                onClick={(ev) => { ev.stopPropagation(); setMuteUserData(undefined); }}
                role="secondary"
              />
              <Button
                text="Mute"
                iconLeft={<VolumeMuteIcon />}
                onClick={handleMuteConfirm}
                role="primary"
              />
            </div>
          </div>
        </Modal>
      )}
      {!!banUserData && (
        <Modal headerText="Ban" close={() => setBanUserData(undefined)}>
          <div className="modal-inner">
            <p>Are you sure you want to ban this user {banUserData.duration === "permanently" ? "" : "for"} {banUserData.duration}?</p>
            <div className="flex flex-row items-center gap-2 mt-1" onClick={() => onCheckboxChange(!checkboxRemoveAllUserPosts)}>
              <CheckboxBase type="checkbox" size="normal" checked={!!checkboxRemoveAllUserPosts} /> 
              <p className="flex-1">Also delete all messages in all channels by this user</p>
            </div>
            <div className="btnList justify-end gap-4 mt-4">
              <Button
                text="Cancel"
                onClick={(ev) => { ev.stopPropagation(); setBanUserData(undefined); }}
                role="secondary"
              />
              <Button
                text="Ban"
                iconLeft={<CloseIcon />}
                onClick={handleBanConfirm}
                role="primary"
              />
            </div>
          </div>
        </Modal>
      )}
    </>
  );

  return (
    <CommunityModerationContext.Provider
      value={{
        warnUser,
        muteUser,
        banUser,
        deleteMessage
      }}
    >
      {props.children}
      {modals}
    </CommunityModerationContext.Provider>
  )
}

export function useCommunityModerationContext() {
  const context = React.useContext(CommunityModerationContext);
  return context;
}