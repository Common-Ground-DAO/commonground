// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import { useSignedUrl } from '../../../hooks/useSignedUrl';
import { Tooltip } from "../../../components/atoms/Tooltip/Tooltip";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import VerifiedIcon from "../../../components/atoms/icons/16/Verified.svg?react";

import './CommunityHeader.css';
import { useCommunityPremiumTier } from "hooks/usePremiumTier";

type Props = {
};

const CommunityHeaderSimple: React.FC<Props> = () => {
  const { community } = useLoadedCommunityContext();
  const imageUrl = useSignedUrl(community.logoLargeId || community.logoSmallId);

  const title = community.title;
  const { tier } = useCommunityPremiumTier(community.premium);

  const communityHeader = React.useMemo(() => {
    let communityIconList: React.JSX.Element[] = [];
    const hasPremiumVisibility = !!tier;

    if (hasPremiumVisibility) {
      communityIconList.push(
        <Tooltip
          key="verified"
          triggerContent={<VerifiedIcon />}
          tooltipContent="Verified community"
          triggerClassName="flex items-center"
          placement="top"
        />
      );
    }

    const communityIcons = <>{communityIconList}</>;

    return <div className="group-caption-container">
      <div className="group-caption">
        <span>{title}</span>
        {communityIcons}
      </div>
    </div>;
  }, [tier, title]);

  return (
    <div className={'community-header'}>
      <div className={`community-container`}>
        <div style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined} className='community-header-group-image' />
        <div className="lobby-title-container">
          {communityHeader}
        </div>
      </div>
    </div>
  );
}

export default React.memo(CommunityHeaderSimple);