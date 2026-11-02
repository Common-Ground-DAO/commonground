// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./MemberApplicationManagement.css";
import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router";

import { useLoadedCommunityContext } from "../../../../context/CommunityProvider";
import { useCommunitySidebarContext } from "../../../organisms/CommunityViewSidebar/CommunityViewSidebarContext";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";

import LeaveCommunityModal from "../../../organisms/LeaveCommunityModal/LeaveCommunityModal";
import Scrollable from "components/molecules/Scrollable/Scrollable";
import { useUserData } from "context/UserDataProvider";

import Button from "components/atoms/Button/Button";
import communityApi from "data/api/community";
import { Asterisk, Warning } from "@phosphor-icons/react";
import { CommunityApprovalState } from "common/enums";
import { ChevronDownIcon } from "@heroicons/react/20/solid";
import ScreenAwarePopover from "components/atoms/ScreenAwarePopover/ScreenAwarePopover";
import { useSnackbarContext } from "context/SnackbarContext";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import { PopoverHandle } from "components/atoms/Tooltip/Tooltip";
import ManagementHeader2 from "components/molecules/ManagementHeader2/ManagementHeader2";
import UserTag from "components/atoms/UserTag/UserTag";

export default function MemberApplicationManagement() {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { showLeaveGroupModal, setShowLeaveGroupModal } = useCommunitySidebarContext();
  const { community, communityPermissions } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const [pendingApprovals, setPendingApprovals] = useState<Models.Community.PendingApproval[]>([]);
  const hasUserApplicationPermission = communityPermissions.has('COMMUNITY_MANAGE_USER_APPLICATIONS');

  useEffect(() => {
    let active = true;
    const fetch = async () => {
      if (hasUserApplicationPermission) {
        const result = await communityApi.getPendingJoinApprovals({ communityId: community.id });
        if (active) setPendingApprovals(result);
      }
    }

    fetch();

    return () => { active = false; }
  }, [community.id, hasUserApplicationPermission]);

  const setAllPending = useCallback(async (state: CommunityApprovalState) => {
    if (state !== CommunityApprovalState.APPROVED && state !== CommunityApprovalState.DENIED) return;
    try {
      await communityApi.setAllPendingJoinApprovals({ communityId: community.id, approvalState: state });
      setPendingApprovals([]);
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Something went wrong, please try again later' });
    }
  }, [community.id, showSnackbar]);

  const className = [
    "member-applications-management cg-text-main",
    isMobile ? 'mobile-member-applications-management' : 'desktop-member-applications-management'
  ].join(' ');

  const pendingApprovalContent = useMemo(() => {
    if (!hasUserApplicationPermission || pendingApprovals.length === 0) {
      return null;
    }

    return <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex gap-2 items-center">
          <span>{pendingApprovals.length} Pending approvals</span>
          <div className="flex gap-1 items-center">
            <Asterisk weight='duotone' className="w-4 h-4 cg-text-warning" />
            <span className="cg-text-secondary cg-text-md-400 flex-1">Only visible to Admins</span>
          </div>
        </div>

        <div className="flex gap-4">
          <ScreenAwarePopover
            triggerContent={<Button
              text='Reject all'
              iconRight={<ChevronDownIcon className="w-4 h-4" />}
              role="textual"
            />}
            triggerType="click"
            closeOn="toggleOrClick"
            placement="bottom"
            tooltipContent={<Button
              role="chip"
              text='Confirm'
              onClick={() => setAllPending(CommunityApprovalState.DENIED)}
            />}
          />
          <ScreenAwarePopover
            triggerContent={<Button
              text='Approve all'
              iconRight={<ChevronDownIcon className="w-4 h-4" />}
              role="textual"
            />}
            triggerType="click"
            closeOn="toggleOrClick"
            placement="bottom"
            tooltipContent={<Button
              role="chip"
              text='Confirm'
              onClick={() => setAllPending(CommunityApprovalState.APPROVED)}
            />}
          />
        </div>
      </div>
      {pendingApprovals.map(pendingApproval => <PendingApprovalItem key={pendingApproval.userId} pendingApproval={pendingApproval} onFinished={() => {
        setPendingApprovals(oldApprovals => oldApprovals.filter(app => app.userId !== pendingApproval.userId));
      }} />)}
    </div>
  }, [hasUserApplicationPermission, pendingApprovals, setAllPending]);

  if (isMobile) {
    return (
      <>
        <div className={className}>
          <ManagementHeader2
            title="Members"
            goBack={() => navigate(-1)}
          />
          <Scrollable>
            {pendingApprovalContent}
          </Scrollable>
        </div>
        <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
      </>
    );
  }
  else {
    return (
      <Scrollable>
        <div className="member-management-view-inner">
          <div className={className}>
            <ManagementHeader2
              title="Member Applications"
              goBack={() => navigate(-1)}
            />
            {pendingApprovalContent}

          </div>
          <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
        </div>
      </Scrollable>
    );
  }
}

type PendingApprovalProps = {
  pendingApproval: Models.Community.PendingApproval;
  onFinished: () => void;
}

const PendingApprovalItem: React.FC<PendingApprovalProps> = (props) => {
  const { pendingApproval, onFinished } = props;
  const [reason, setReason] = useState('');
  const user = useUserData(pendingApproval.userId);
  const blockRef = useRef<PopoverHandle>(null);
  const rejectRef = useRef<PopoverHandle>(null);

  const onSelect = async (state: CommunityApprovalState, message?: string) => {
    await communityApi.setPendingJoinApproval({
      communityId: pendingApproval.communityId,
      userId: pendingApproval.userId,
      approvalState: state,
      message
    });
    blockRef.current?.close();
    rejectRef.current?.close();
    onFinished();
  }

  return <div className="member-management-pending">
    <div className="flex flex-col p-4 gap-2">
      <div className="flex justify-between items-center gap-4 flex-wrap">
        {user && <UserTag
          userData={user}
          jdenticonSize="40"
          noOfflineDimming
          hideStatus
          largeNameFont
        />}
        <div className="flex items-center gap-4">
          <ScreenAwarePopover
            ref={blockRef}
            triggerContent={<Button
              iconLeft={<Warning className="w-4 h-4 cg-text-warning" />}
              text='Block'
              iconRight={<ChevronDownIcon className="w-4 h-4" />}
              role="textual"
            />}
            triggerType="click"
            closeOn="toggle"
            placement="bottom"
            tooltipContent={<div className="flex flex-col gap-2 p-3">
              <TextInputField
                label={<div className="flex gap-0.5">Reason <span className="cg-text-secondary cg-text-lg-500">(optional)</span></div>}
                value={reason}
                onChange={setReason}
                placeholder="Enter a reason"
                maxLetters={50}
              />
              <Button
                className="w-full"
                role="chip"
                text='Confirm'
                onClick={() => onSelect(CommunityApprovalState.BLOCKED, reason)}
              />
            </div>}
          />
          <ScreenAwarePopover
            ref={rejectRef}
            triggerContent={<Button
              text='Reject'
              iconRight={<ChevronDownIcon className="w-4 h-4" />}
              role="textual"
            />}
            triggerType="click"
            closeOn="toggle"
            placement="bottom"
            tooltipContent={<div className="flex flex-col gap-2 p-3">
              <TextInputField
                label={<div className="flex gap-0.5">Reason <span className="cg-text-secondary cg-text-lg-500">(optional)</span></div>}
                value={reason}
                onChange={setReason}
                placeholder="Enter a reason"
                maxLetters={50}
              />
              <Button
                className="w-full"
                role="chip"
                text='Confirm'
                onClick={() => onSelect(CommunityApprovalState.DENIED, reason)}
              />
            </div>}
          />
          <Button
            role="chip"
            text='Approve'
            onClick={() => onSelect(CommunityApprovalState.APPROVED)}
          />
        </div>
      </div>
      {(pendingApproval.questionnaireAnswers?.length || 0) > 0 && pendingApproval.questionnaireAnswers?.map(question => <div className="flex flex-col gap-2" key={question.question}>
        <div className="flex flex-col gap-1">
          <span className="cg-text-lg-500">{question.question}</span>
          {question.type === 'text' && <span className="cg-text-md-400">{question.answer[0]}</span>}
          {question.type !== 'text' && <div className="flex gap-1 flex-wrap">
            {question.answer.map(answer => <div className="cg-bg-subtle py-1 px-2 cg-border-xl" key={answer}>
              {answer}
            </div>)}
          </div>}
        </div>
      </div>)}
    </div>
  </div>;
}
