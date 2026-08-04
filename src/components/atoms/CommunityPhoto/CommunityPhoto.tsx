// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useLocation } from 'react-router-dom';

import "./CommunityPhoto.css";
import { getUrl } from 'common/util';
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import OfficialIcon from "../../../components/atoms/icons/20/OfficialIcon.svg?react";
import { useMemo } from 'react';
import dayjs from 'dayjs';
import { getTierElementIcon } from 'util/index';

type Props = {
    community: Pick<Models.Community.ListView, 'logoSmallId' | 'logoLargeId' | 'official' | 'premium' | 'url'>;
    size: 'small' | 'small-32' | 'tiny' | 'large' | 'medium' | 'tiny-20';
    noHover?: boolean;
    showExtraIcon?: boolean;
}

export default function CommunityPhoto(props: Props) {
    const { community, size, noHover, showExtraIcon } = props;
    const location = useLocation();
    const signedUrl = useLiveQuery(() => {
        if (size === 'small' || size === 'small-32' || size === 'tiny' || size === 'medium' || size === 'tiny-20') {
            if (community.logoSmallId) return data.signedUrls.getSignedUrl(community.logoSmallId);
        } else {
            const url = community.logoLargeId || community.logoSmallId;
            if (url) return data.signedUrls.getSignedUrl(url);
        }
    }, [community?.logoLargeId, community?.logoSmallId, size]);

    const className = useMemo(() => ([
        'community-photo',
        size,
        !noHover && location.pathname.includes(getUrl({ type: 'community-lobby', community })) ? "active" : "",
        noHover ? 'noHover' : ''
    ].join(' ').trim()
    ), [size, noHover, location.pathname, community?.url]);

    return useMemo(() => {
        let extraIcon: React.JSX.Element | undefined = undefined;
        if (showExtraIcon) {
            if (!!community.official) {
                extraIcon = <OfficialIcon className="community-photo-official-icon w-4 h-4 absolute -right-1 -bottom-1"/>;
            }
            else if (!!community.premium && dayjs(community.premium.activeUntil).isAfter(dayjs())) {
                extraIcon = getTierElementIcon(community.premium.featureName, "community-photo-official-icon w-4 h-4 absolute -right-1 -bottom-1")!;
            }
        }

        return <div className={className} style={!!signedUrl ? { backgroundImage: `url(${signedUrl.url})` } : undefined}>
            {extraIcon}
        </div>;
    }, [className, signedUrl?.url, showExtraIcon, community.official]);
}
