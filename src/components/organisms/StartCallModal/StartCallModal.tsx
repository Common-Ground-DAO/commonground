// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./StartCallModal.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PhoneIcon,
  SignalIcon,
} from "@heroicons/react/20/solid";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { InformationCircleIcon } from "@heroicons/react/24/solid";
import { useLoadedCommunityContext } from "context/CommunityProvider";

import Button from "components/atoms/Button/Button";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import { useCallContext } from "context/CallProvider";
import ScreenAwareModal from "components/atoms/ScreenAwareModal/ScreenAwareModal";
import { useNavigate } from "react-router";
import { getUrl } from "common/util";
import RolePermissionToggle, {
  PermissionType,
} from "components/molecules/RolePermissionToggle/RolePermissionToggle";
import ToggleInputField from "components/molecules/inputs/ToggleInputField/ToggleInputField";
import { CallType, PredefinedRole } from "common/enums";
import CallConfigurationToggle, { IConfig } from "./CallConfigurationToggle/CallConfigurationToggle";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { useCommunityPremiumTier } from "hooks/usePremiumTier";

type Props = {
  title: string;
  open: boolean;
  onClose: () => void;
};

export const StartCallModal = (props: React.PropsWithChildren<Props>) => {
  const [callName, setCallName] = useState<string>();
  const [callAgenda, setCallAgenda] = useState<string>();
  const { community, ownRoles, roles } = useLoadedCommunityContext();
  const { isMobile } = useWindowSizeContext();
  const [isCustomCall, setIscustomCall] = useState<boolean>(false);
  const [isBroadcast, setIsBroadcast] = useState<boolean>(false);
  const [isGroupCall, setIsGroupCall] = useState<boolean>(true);
  const [callPermissions, setCallPermissions] = useState<{
    [id: string]: PermissionType;
  }>({});

  const { premium } = community;
  const { tier, tierData } = useCommunityPremiumTier(premium);

  const [callConfig, setCallConfig] = useState<IConfig>({
    stageLimit: tierData.BROADCASTERS_SLOTS,
    overallCallLimit: tierData.CALL_STANDARD,
    highDefinition: false,
    audioOnly: false,
  });
  const callNameInputRef = useRef<HTMLInputElement>(null);
  const callContext = useCallContext();
  const navigate = useNavigate();

  const canCreateCustomCalls = ownRoles.some((r) =>
    r.permissions.includes("WEBRTC_CREATE_CUSTOM")
  );

  useEffect(() => {
    // on open, focus on first input
    if (props.open) {
      callNameInputRef.current?.focus();
    }
  }, [props.open]);

  //pre-fill call permissions with full for all roles
  useEffect(() => {
    canCreateCustomCalls &&
      ownRoles.forEach((role) => {
        if (role.title === "Admin") {
          return;
        } else {
          setCallPermissions((prev) => ({
            ...prev,
            [role.id]: "full",
          }));
        }
      });
  }, [canCreateCustomCalls, ownRoles]);

  const navigateToCall = useCallback(
    (call: Models.Calls.Call) => {
      navigate(getUrl({ type: "community-call", community, call }));
    },
    [navigate, community]
  );

  const handleStartCall = useCallback(() => {
    const communityId = community?.id;
    if (!communityId) {
      console.error("No community id");
      return;
    }
    if (!callPermissions) {
      console.error("No call permissions");
      return;
    }
    callContext
      .startCall(
        communityId,
        callName || "New call",
        callAgenda || null,
        isBroadcast ? CallType.BROADCAST : CallType.DEFAULT,
        callConfig.overallCallLimit,
        callConfig.stageLimit,
        callConfig.highDefinition,
        callConfig.audioOnly,
        !isCustomCall ? undefined : callPermissions
      )
      ?.then((call) => {
        navigateToCall(call);
      });

    setCallName(undefined);
    setCallAgenda(undefined);
    setCallPermissions({});
    props.onClose();
  }, [
    callAgenda,
    callConfig.audioOnly,
    callConfig.highDefinition,
    callConfig.overallCallLimit,
    callConfig.stageLimit,
    callContext,
    callName,
    callPermissions,
    community?.id,
    isBroadcast,
    isCustomCall,
    navigateToCall,
    props,
  ]);

  const onKeyPress = useCallback(
    (e: React.KeyboardEvent<Element>) => {
      if (e.key === "Enter") {
        handleStartCall();
      }
    },
    [handleStartCall]
  );

  const visibleRoles = useMemo(() => {
    if (ownRoles.some((role) => role.title === PredefinedRole.Admin))
      return roles;
    return ownRoles;
  }, [ownRoles, roles]);

  const children = useMemo(
    () => (
      <div className="start-call-modal cg-text-main">
        <div className="flex items-start gap-2 self-stretch">
          <Button
            role="chip"
            text="Group call"
            iconLeft={<PhoneIcon className="w-5 h-5" />}
            onClick={() => {
              setIsGroupCall(true);
              setIsBroadcast(false);
            }}
            className={isGroupCall ? "active" : undefined}
          />
          <Button
            role="chip"
            text="Broadcast"
            iconLeft={<SignalIcon className="w-5 h-5" />}
            onClick={() => {
              setIsGroupCall(false);
              setIsBroadcast(true);
            }}
            className={isBroadcast ? "active" : undefined}
          />
        </div>
        <div className="info-tag">
          <InformationCircleIcon className="flex w-5 h-5" />
          <span className="call-inputs-label">
            {isBroadcast
              ? "In Broadcasts, you decide who can speak"
              : "In Group Calls, anyone can speak"}
          </span>
        </div>
        <TextInputField
          label="Call name"
          onChange={setCallName}
          value={callName || ""}
          type="text"
          placeholder="e.g. Daily Standup"
          onKeyPress={onKeyPress}
          inputRef={callNameInputRef}
        />
        <TextInputField
          label="Agenda"
          onChange={setCallAgenda}
          value={callAgenda || ""}
          placeholder="What's this call about?"
          onKeyPress={onKeyPress}
        />
        {canCreateCustomCalls && (
          <CallConfigurationToggle
            premiumConfig={tierData}
            isBroadcast={isBroadcast}
            callConfig={callConfig}
            setCallConfig={setCallConfig}
          />
        )}
        {canCreateCustomCalls && (<div className="cg-bg-subtle flex flex-col gap-4 p-4 cg-border-l">
          <div className="flex flex-row w-full gap-2 items-center">
            <LockClosedIcon className="flex w-5 h-5" />
            <ToggleInputField
              className="limit-access"
              toggled={isCustomCall}
              onChange={setIscustomCall}
              label="Limit Access"
            />
          </div>
          {isCustomCall && (
            <RolePermissionToggle
              title=""
              subtitle="Roles you do not have are hidden in these settings"
              roles={visibleRoles}
              rolesPermissions={callPermissions}
              availablePermissions={["full", "moderate", "none"]}
              setRolesPermissions={setCallPermissions}
            />
          )}
        </div>)}
      </div>
    ),
    [
      callAgenda,
      callConfig,
      callName,
      callPermissions,
      canCreateCustomCalls,
      tier,
      isBroadcast,
      isCustomCall,
      isGroupCall,
      onKeyPress,
      visibleRoles,
    ]
  );

  return (
    <ScreenAwareModal
      title={"Start a call"}
      children={children}
      isOpen={props.open}
      onClose={() => {
        props.onClose();
      }}
      footerActions={<>
        <Button
          className={isMobile ? "w-full" : ''}
          text={"Start call"}
          onClick={handleStartCall}
          iconLeft={<PhoneIcon className="h-5 w-5" />}
          role="primary"
        />
      </>}
    />
  );
};
