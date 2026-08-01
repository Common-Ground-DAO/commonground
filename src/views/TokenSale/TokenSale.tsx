// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import './TokenSale.css';
import dayjs from 'dayjs';
import Button from 'components/atoms/Button/Button';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import SparkFireBg from 'components/organisms/UserSettingsModalContent/HowSparkWorks/SparkFireBg';
import { ReactComponent as SparkIcon } from 'components/atoms/icons/misc/spark.svg';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import StakeTab from './StakeTab/StakeTab';

const learnMoreLink = 'https://app.cg/c/commonground/article/introducing-spark---upgrade-your-community-%26-support-common-ground-svnJ15teLA9JxAxCC8yafT';

export function calculateAgeString(date: Date) {
    let _date = dayjs(date);
    const now = dayjs();

    if (_date.isAfter(now)) {
        _date = now;
    }

    if (now.diff(_date, 'days') >= 7) {
        const sameYear = now.year() === _date.year();
        return _date.format(sameYear ? 'MMM DD' : 'MMM DD, YYYY');
    }
    const diffDays = now.diff(_date, 'days');
    const diffHours = now.diff(_date, 'hours');
    const diffMinutes = now.diff(_date, 'minutes');

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMinutes > 0) return `${diffMinutes}m ago`;

    return `<1m ago`;
}

export function calculateTimeUntil(date: dayjs.Dayjs) {
    const now = dayjs();
    if (date.isBefore(now)) {
        return 'Now';
    }

    const fullDiffSeconds = date.diff(now, 'seconds');
    const diffSeconds = fullDiffSeconds % 60;
    const diffMinutes = Math.floor(fullDiffSeconds / 60) % 60;
    const diffHours = Math.floor(fullDiffSeconds / 60 / 60) % 24;
    const diffDays = Math.floor(fullDiffSeconds / 60 / 60 / 24);

    return `${diffDays}d ${diffHours.toString().padStart(2, '0')}h ${diffMinutes.toString().padStart(2, '0')}m ${diffSeconds.toString().padStart(2, '0')}s`;
}

const TokenSale: React.FC = () => {
    const { isMobile } = useWindowSizeContext();

    // Shown instead of the staking UI while the user is logged out or the
    // staking service is not configured on this instance.
    const comingSoon = <div className='flex flex-col items-center cg-content-stack cg-border-xl'>
        <div className='flex flex-col justify-between items-center cg-text-main cg-text-lg-400 p-4 gap-10 relative'>
            <SparkFireBg />

            <div className='flex flex-col gap-6 z-10'>
                <div className='flex gap-1 items-center justify-center'>
                    <SparkIcon className='w-8 h-8' />
                    <span className='spark-title'>Spark</span>
                </div>
                <div className='flex flex-col items-center justify-center gap-1'>
                    <h3 className='cg-heading-3'>What is it?</h3>
                    <span className='text-center'>Spark is an offchain currency, use it to upgrade communities and keep Common Ground alive. <SimpleLink className='underline cursor-pointer' href={learnMoreLink}>Learn more</SimpleLink></span>
                </div>
                <div className='flex flex-col items-center justify-center gap-1'>
                    <h3 className='cg-heading-3'>How do I get it?</h3>
                    <span className='text-center'>
                        We're working hard to enable staking so you can earn Spark. This feature will be available soon — please check back for updates!
                    </span>
                </div>
            </div>
            <div className='flex flex-col gap-2 self-stretch z-10'>
                <Button
                    className='max-w-full w-full'
                    disabled
                    text='Stake for Spark'
                    role='primary'
                    iconLeft={<SparkIcon className='w-5 h-5' />}
                />
            </div>
        </div>
    </div>;

    return (
        <Scrollable>
            <div className="tokensale-root cg-text-main">
                <div className="tokensale-header relative">
                    <img
                        className={`absolute ${isMobile ? 'top-3' : 'top-12'} left-1/2 -translate-x-1/2`}
                        src="/logo.svg"
                        width={70}
                        height={70}
                        alt="Common Ground Logo"
                    />
                    <div className="tokensale-header-image flex justify-center">
                        <img
                            src="/images/tokensale_header.webp"
                            alt="Token Sale Header"
                        />
                    </div>
                    <div className="tokensale-header-text">
                        <span className="tokensale-header-text-bottom z-10">
                            play. build. own.<br />
                            On Common Ground
                        </span>
                    </div>
                </div>

                <div className="tokensale-content tokensale-content-card tokensale-content-card-top cg-content-stack z-10">
                    <StakeTab comingSoon={comingSoon} />
                </div>
                <div />
            </div>
        </Scrollable>
    );
}

export default TokenSale;
