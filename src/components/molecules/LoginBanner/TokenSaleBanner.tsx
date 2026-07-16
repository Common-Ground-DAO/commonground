// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from 'components/atoms/Button/Button';
import './LoginBanner.css';
import React, { useEffect, useState } from 'react';
import bannerBg from './bannerbg.webp';

import { ArrowRightIcon, ChevronUpIcon } from '@heroicons/react/20/solid';
import { calculateTimeUntil, SALE_END_DATE, SALE_START_DATE, tokenSaleId } from 'views/TokenSale/TokenSale';
import dayjs from 'dayjs';
import userApi from 'data/api/user';
import { useNavigate } from 'react-router-dom';
import useLocalStorage from 'hooks/useLocalStorage';

type Props = {};

const TokenSaleBanner: React.FC<Props> = () => {
  const navigate = useNavigate();
  const [timeForSaleStart, setTimeForSaleStart] = useState<string | null>(null);
  const [timeForSaleEnd, setTimeForSaleEnd] = useState<string | null>(null);
  const [saleHasStarted, setSaleHasStarted] = useState(dayjs(SALE_START_DATE).isBefore(dayjs()));
  const [saleHasEnded, setSaleHasEnded] = useState(dayjs(SALE_END_DATE).isBefore(dayjs()));
  const [tokenSaleData, setTokenSaleData] = useState<Models.TokenSale.SaleData | null>(null);
  const [expanded, setExpanded] = useLocalStorage(true, 'tokenSaleExpanded');

  useEffect(() => {
    const update = () => {
      userApi.getOwnTokenSaleData({ tokenSaleId }).then(data => {
        setTokenSaleData(data.tokenSaleData);
      }).catch(e => {
        console.error("Error getting own token sale data", e);
      });
    }
    update();
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    const refreshTimeUntil = () => {
      const timeUntil = calculateTimeUntil(dayjs(SALE_START_DATE));
      setTimeForSaleStart(old => {
        if (timeUntil === 'Now') {
          setSaleHasStarted(true);
        }
        return timeUntil;
      });

      const hasEnded = dayjs(SALE_END_DATE).isBefore(dayjs());
      if (hasEnded) {
        setSaleHasEnded(hasEnded);
      }

      if (timeUntil === 'Now' && hasEnded) {
        clearInterval(interval);
      }
    }

    refreshTimeUntil();
    interval = setInterval(refreshTimeUntil, 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    const refreshTimeUntil = () => {
      const timeUntil = calculateTimeUntil(dayjs(tokenSaleData?.endDate));
      setTimeForSaleEnd(old => {
        if (timeUntil !== 'Now') {
          return timeUntil;
        }
        return old;
      });

      if (timeUntil === 'Now') {
        clearInterval(interval);
      }
    }

    refreshTimeUntil();
    interval = setInterval(refreshTimeUntil, 1_000);
    return () => clearInterval(interval);
  }, [tokenSaleData?.endDate]);

  const className = [
    'login-banner cg-text-main',
  ].join(' ').trim();

  const getContent = () => {
    if (!saleHasStarted) {
      return <div className='flex flex-col justify-center items-center py-2 gap-2 flex-1 z-10'>
        <h2 className='text-center'>The $CG Sale starts soon</h2>
        <h1 className='text-center token-sale-monospace'>{timeForSaleStart}</h1>
        <h3 className='text-center'>Build the Common Ground you want to see</h3>
      </div>
    } else {
      return <>
        <div className='flex flex-col justify-center items-center py-2 gap-2 flex-1 z-10'>
          <h2 className='text-center'>The $CG Sale is live</h2>
          <h3 className='text-center'>Build the Common Ground you want to see</h3>
        </div>
        <div className='absolute top-4 right-4 flex items-center gap-2 z-10'>
          <div className='token-sale-tag'>LIVE</div>
          {!!timeForSaleEnd && <div className='token-sale-tag token-sale-monospace'>{timeForSaleEnd}</div>}
        </div>
      </>
    }
  }

  const getButtonText = () => {
    if (!saleHasStarted) {
      return 'Read our vision';
    } else {
      return 'Own a piece of Common Ground';
    }
  }

  if (saleHasEnded) {
    return null;
  }

  return <div className='flex flex-col gap-2'>
    <div className='flex items-center cursor-pointer cg-text-secondary' onClick={() => setExpanded(old => !old)}>
      <p>Stake</p>
      <ChevronUpIcon className={`w-5 h-5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </div>
    {expanded && <div className='login-banner-container'>
      <div className={className}>
        {getContent()}
        <div className='absolute inset-0 bg-center bg-cover bg-no-repeat opacity-50' style={{ backgroundImage: `url(${bannerBg})` }} />
        <div className='flex gap-2 w-full items-center justify-center z-10'>
          <Button className='w-60' role='primary' text={getButtonText()} iconRight={<ArrowRightIcon className='w-5 h-5 cg-text-secondary' />} onClick={() => {
            navigate('/token');
          }} />
        </div>
      </div>
    </div>}
  </div>
}

export default React.memo(TokenSaleBanner);