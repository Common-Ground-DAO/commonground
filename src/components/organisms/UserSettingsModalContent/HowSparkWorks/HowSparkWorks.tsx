// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import ExternalIcon from 'components/atoms/ExternalIcon/ExternalIcon';
import './HowSparkWorks.css';
import Button from 'components/atoms/Button/Button';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import React from 'react';
import SparkFireBg from './SparkFireBg';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';

const learnMoreLink = 'https://app.cg/c/commonground/article/introducing-spark---upgrade-your-community-%26-support-common-ground-svnJ15teLA9JxAxCC8yafT';

const HowSparkWorks = () => {
  const { setCurrentPage } = useUserSettingsContext();
  return <div className='flex flex-col justify-between items-center cg-text-main cg-text-lg-400 p-4 gap-10 relative'>
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
        <span className='text-center'>Buy Spark by swapping <span className='cg-text-lg-500'>USDC</span>, <span className='cg-text-lg-500'>USDT</span> or <span className='cg-text-lg-500'>DAI</span> for <span className='cg-text-lg-500'>Spark</span></span>
        <div className='flex gap-2'>
          {<ExternalIcon type='dai' className='w-8 h-8' />}
          {<ExternalIcon type='usdc' className='w-8 h-8' />}
          {<ExternalIcon type='usdt' className='w-8 h-8' />}
        </div>
      </div>
    </div>
    <div className='flex flex-col gap-2 self-stretch z-10'>
      <Button
        className='max-w-full w-full'
        text='Get Spark'
        role='primary'
        iconLeft={<SparkIcon className='w-5 h-5' />}
        onClick={() => setCurrentPage('get-spark')}
      />
      <Button
        className='max-w-full w-full'
        text='Not now'
        role='secondary'
        onClick={() => setCurrentPage('home')}
      />
    </div>
  </div>;
}

export default React.memo(HowSparkWorks);