// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./SumsubKyc.css";
import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import config from "common/config";
import SumsubWebSdk from "@sumsub/websdk-react";
import { MessageHandler, ErrorHandler } from "@sumsub/websdk";
import { EventPayload, SnsError } from "@sumsub/websdk/types/types";
import { useSumsubContext } from "context/SumsubContext";
import { ReactComponent as SpinnerIcon } from "../../atoms/icons/16/Spinner.svg";
import { useDarkModeContext } from "context/DarkModeProvider";
import { useSnackbarContext } from "context/SnackbarContext";
import { useOwnUser } from "context/OwnDataProvider";
import Scrollable from "../Scrollable/Scrollable";
import Button from "components/atoms/Button/Button";

type Props = {
  kycType: API.Sumsub.KycType;
  handleWizardAction: (action: Models.Wizard.WizardAction) => void;
  actions: Models.Wizard.WizardAction[];

  sidebarMode?: boolean;
  onSuccessSidebar?: () => void;
};

const getKycSuccess = (kycType: API.Sumsub.KycType, ownUser: Models.User.OwnData | undefined): boolean => {
  switch (kycType) {
    case 'liveness-only':
      return ownUser?.extraData?.kycLivenessSuccess || false;
    case 'full-kyc-level':
      return ownUser?.extraData?.kycFullSuccess || false;
    case 'cg-tokensale':
      return ownUser?.extraData?.kycCgTokensaleSuccess || false;
    default:
      return false;
  }
};

export default function SumsubKyc({ kycType, handleWizardAction, actions, sidebarMode, onSuccessSidebar }: Props) {
  const { accessToken, accessTokenExpirationHandler, fetchAccessToken } = useSumsubContext();
  const mode = useDarkModeContext();
  const { showSnackbar } = useSnackbarContext();
  const [reviewCompleted, setReviewCompleted] = useState<boolean>(false);
  const ownUser = useOwnUser();
  const hasKycSucceeded = useMemo(() => getKycSuccess(kycType, ownUser), [kycType, ownUser]);
  const didSuccessNavigate = useRef(false);

  useEffect(() => {
    fetchAccessToken(kycType);
  }, [fetchAccessToken, kycType]);

  useEffect(() => {
    if (reviewCompleted && hasKycSucceeded && !didSuccessNavigate.current) {
      if (sidebarMode && onSuccessSidebar) {
        onSuccessSidebar();
      } else {
        const getGoToNextAction = actions.find(action => action.text === "Continue");
        if (!getGoToNextAction) {
          console.error("No action to go to next step found");
          return;
        }
        handleWizardAction(getGoToNextAction);
      }
      didSuccessNavigate.current = true;
    }
  }, [reviewCompleted, hasKycSucceeded, handleWizardAction, actions, sidebarMode, onSuccessSidebar]);

  const messageHandler: MessageHandler = useCallback((eventType, payload) => {
    try {
      console.log(eventType);
      switch (eventType) {
        case "idCheck.onApplicantStatusChanged":
          console.log(payload);
          const { reviewStatus } = payload as EventPayload<"idCheck.onApplicantStatusChanged">;
          if (reviewStatus === "completed") {
            setReviewCompleted(true);
            console.log("KYC completed");
          }
          break;
        case "idCheck.onApplicantResubmitted":
          console.log(payload);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }, []);

  const errorHandler: ErrorHandler = useCallback((error: SnsError) => {
    console.error("Error in SumsubWebSdk:", error.error);
    showSnackbar({ text: "Error in SumsubWebSdk", type: "warning" });
  }, [showSnackbar]);

  const helpAction = useMemo(() => {
    return actions.find(action => action.action.type === "goto" && action.action.navigate.type === "openLink");
  }, [actions]);

  const content = useMemo(() => {
    if (!config.KYC_ENABLED) {
      // instances without SumSub credentials can't run KYC — say so instead
      // of spinning forever
      return (
        <div className={`sumsub-kyc mt-8${sidebarMode ? ' sidebar-mode' : ''}`}>
          <div className="flex justify-center m-8 text-center cg-text-main">
            Identity verification is not available on this instance.
          </div>
        </div>
      );
    }
    else if (!accessToken) {
      return (
        <div className={`sumsub-kyc mt-8${sidebarMode ? ' sidebar-mode' : ''}`}>
          <div className="spinner flex justify-center m-8">
            <SpinnerIcon className="w-10 h-10" />
          </div>
        </div>
      );
    } else {
      return (
        <div className={`fullscreen-wizard-step sumsub-kyc pt-8${sidebarMode ? ' sidebar-mode' : ''}`}>
          <Scrollable alwaysVisible>
            <SumsubWebSdk
              accessToken={accessToken}
              expirationHandler={accessTokenExpirationHandler}
              config={{ theme: mode.isDarkMode ? "dark" : "light" }}
              options={{}}
              onMessage={messageHandler}
              onError={errorHandler}
            />
          </Scrollable>
          {!!helpAction && (
            <div className='flex items-center gap-2'>
              <span className='text-sm'>{helpAction.text}</span>
              <Button
                role={helpAction.role}
                key={helpAction.text}
                text={"Open Telegram"}
                onClick={() => handleWizardAction(helpAction)}
                disabled={helpAction.disabled}
                className='text-sm'
              />
            </div>
          )}
        </div>
      );
    }
  }, [accessToken, sidebarMode, accessTokenExpirationHandler, mode.isDarkMode, messageHandler, errorHandler, helpAction, handleWizardAction]);

  return content;
}
