// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useState } from 'react'
import Button, { ButtonRole } from '../Button/Button';
import { useOwnUser } from 'context/OwnDataProvider';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import data from 'data';
import { useCommunityJoinedContext } from 'context/CommunityJoinedProvider';
import { useCommunityOnboardingContext } from 'context/CommunityOnboardingProvider';
import { CommunityApprovalState } from 'common/enums';
import errors from 'common/errors';
import { useSnackbarContext } from 'context/SnackbarContext';
import { checkCommunityRequirements } from 'common/util';

type Props = {
  community: Models.Community.DetailView | undefined;
  iconLeft?: React.JSX.Element;
  text?: string;
  className?: string;
  onSuccess?: () => void;
  onStartUserOnboarding?: () => void;
  role?: ButtonRole;
};

const JoinCommunityButton: React.FC<Props> = (props) => {
  const { 
    community,
    iconLeft,
    className,
    text,
    onSuccess,
    onStartUserOnboarding,
    role
  } = props;
  const ownUser = useOwnUser();
  const { setUserOnboardingVisibility } = useUserOnboardingContext();
  const { openModal } = useCommunityJoinedContext();
  const { openRequirementsModal, openQuestionnaireModal } = useCommunityOnboardingContext();
  const { showSnackbar } = useSnackbarContext();
  const [loading, setLoading] = useState(false);
  const communityId = community?.id;

  const joinCommunity = useCallback(async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!ownUser?.id) {
      onStartUserOnboarding?.();
      setUserOnboardingVisibility(true);
      return;
    }

    if (!communityId) return;

    setLoading(true);
    const community = await data.community.fetchFreshCommunityDetailView(communityId);
    if (community.onboardingOptions?.passwordProtected?.enabled) {
      openRequirementsModal(community as any as Models.Community.DetailView);
    } else if (community.onboardingOptions?.requirements?.enabled && !!checkCommunityRequirements(community.onboardingOptions.requirements, ownUser)) {
      openRequirementsModal(community as any as Models.Community.DetailView);
    } else if (community.onboardingOptions?.questionnaire?.enabled) {
      openQuestionnaireModal(community as any as Models.Community.DetailView);
    } else {
      try {
        await data.community.joinCommunity({
          id: community.id
        });
        openModal(community.id);
        onSuccess?.();
      } catch (e: any) {
        if (e.message === errors.server.COMMUNITY_JOIN_IN_WAIT_PERIOD) {
          showSnackbar({type: 'warning', text: 'You last join request has been denied, please try again tomorrow'});
        } else {
          console.error(e);
        }
      }
    }
    setLoading(false);
  }, [communityId, onStartUserOnboarding, onSuccess, openModal, openQuestionnaireModal, openRequirementsModal, ownUser?.id, setUserOnboardingVisibility, showSnackbar]);

  const btnText = useMemo(() => {
    if (community?.myApplicationStatus === CommunityApprovalState.PENDING) return 'Waiting for approval';

    if (!!text) return text;
    if (!community?.onboardingOptions?.manuallyApprove?.enabled) return 'Join Community';

    // TODO: Check if user is pending
    return 'Apply to join community';
  }, [community?.myApplicationStatus, community?.onboardingOptions?.manuallyApprove?.enabled, text]);

  return <Button
    role={role || 'primary'}
    iconLeft={!!community && community.myApplicationStatus !== CommunityApprovalState.PENDING ? iconLeft : undefined}
    loading={loading}
    disabled={!community || community.myApplicationStatus === CommunityApprovalState.PENDING}
    className={className}
    text={btnText}
    onClick={joinCommunity}
  />
}

export default React.memo(JoinCommunityButton);