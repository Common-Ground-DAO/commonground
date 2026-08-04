// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { getDisplayName } from "../../../util";

import { Tooltip } from "../../../components/atoms/Tooltip/Tooltip";

import "./UsernameWithVerifiedIcon.css";
import SkeletonLine from "components/atoms/SkeletonLine/SkeletonLine";
import { useMemo } from "react";
import { UserPremiumFeatureName } from "common/enums";
import SupporterIcon from "components/atoms/SupporterIcon/SupporterIcon";
import BotBadge from "components/atoms/BotBadge/BotBadge";

type Properties = {
    userId?: string;
    userData?: Pick<Models.User.Data, 'premiumFeatures' | 'accounts' | 'displayAccount' | 'id' | 'isBot'>;
    disableTooltip?: boolean;
}

export default function UsernameWithVerifiedIcon(props: Properties) {
    const { userId, userData, disableTooltip } = props;

    const userName = !!userId && !!userData ? getDisplayName(userData) : userId;
    const verifiedIcon: React.JSX.Element | null = useMemo(() => {
        if (!userData?.premiumFeatures) {
            return null;
        }

        let icon: React.JSX.Element | null = null;
        if (userData.premiumFeatures.some(f => f.featureName === UserPremiumFeatureName.SUPPORTER_2 && new Date(f.activeUntil) > new Date())) {
            icon = <SupporterIcon type="gold" size={20} />;
        }
        else if (userData.premiumFeatures.some(f => f.featureName === UserPremiumFeatureName.SUPPORTER_1 && new Date(f.activeUntil) > new Date())) {
            icon = <SupporterIcon type="silver" size={20} />;
        }

        if (!icon) return null;
        if (disableTooltip) {
            return icon;
        } else {
            const supporterTier = userData.premiumFeatures.some(f => f.featureName === UserPremiumFeatureName.SUPPORTER_2) ? 'Gold' : 'Silver';

            return (
                <Tooltip
                    triggerContent={icon}
                    triggerClassName="tooltip-verified-user"
                    tooltipContent={`CG ${supporterTier} supporter`}
                    placement="top"
                />
            );
        }

    }, [userData?.premiumFeatures, disableTooltip]);

    let content: React.JSX.Element;
    if (!userId) {
        content = <SkeletonLine minWidth={80} maxWidth={120} />;
    }
    else {
        content = (<>
            <span className="overflow-hidden text-ellipsis">{userName}</span>
            {userData?.isBot && <BotBadge disableTooltip={disableTooltip} />}
            {verifiedIcon}
        </>);
    }
    return content;
}
