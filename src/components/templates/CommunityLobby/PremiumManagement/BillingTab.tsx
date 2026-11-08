// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect } from "react";
import { useLoadedCommunityContext } from "context/CommunityProvider";

import { ArrowRightOnRectangleIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import communityApi from "data/api/community";
import dayjs from "dayjs";
import { useUserData } from "context/UserDataProvider";
import UserTag from "components/atoms/UserTag/UserTag";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { getTierIcon, getTierTitle } from "util/index";

const BillingTab: React.FC = () => {
  const { community } = useLoadedCommunityContext();
  const [transactions, setTransactions] = React.useState<Models.Premium.Transaction[]>([]);
  useEffect(() => {
    let mounted = true;
    communityApi.getTransactionData({ communityId: community.id })
      .then((transactionsFromApi) => {
        if (mounted) {
          setTransactions(transactionsFromApi.map(t => {
            return {
              ...t,
              createdAt: new Date(t.createdAt)
            };
          }));
        }
      });

    return () => { mounted = false };
  }, [community.id]);

  return <div className="flex flex-col gap-4 cg-text-main">
    <div className="flex self-stretch justify-between items-center p-2 gap-2">
      <h3 className="cg-heading-3">Billing</h3>
      {/* <Button
        text='Export .csv'
        role="secondary"
      /> */}
    </div>
    {/* <div className="flex flex-col gap-2">
      <h3 className="cg-heading-3 p-2">Upcoming Payments</h3>
      <div className="premium-settings-border-container solid">
        <UpcomingPayment />
        <UpcomingPayment />
        <UpcomingPayment />
      </div>
    </div> */}
    <div className="flex flex-col gap-2">
      <h3 className="cg-heading-3 p-2">History</h3>
      {transactions.length === 0 && <h3 className="p-2">No billing history</h3>}
      {transactions.length > 0 && <div className="premium-settings-border-container">
        {transactions.map(t => <HistoryPayment transaction={t} key={t.id} />)}
      </div>}
    </div>
  </div>
};

type UpcomingPaymentProps = {};

const UpcomingPayment: React.FC<UpcomingPaymentProps> = (props) => {
  return <div className="flex flex-col p-4">
    <div className="flex self-stretch items-center gap-2">
      <div className="flex items-center gap-1 flex-1">
        {/* FIXME: Generalize the getIcon function from UpgradesTab to use it here */}
        <div className="cg-bg-subtle h-8 w-8 cg-border-l">
          {getTierIcon('BASIC')}
        </div>
        <span>Mock Data mock data</span>
      </div>
      <div className="flex items-center gap-1">
        <span>Ends Apr 27, 2024</span>
        <ArrowRightOnRectangleIcon className="w-5 h-5 cg-text-secondary" />
      </div>
    </div>
    <div className="flex gap-4 self-stretch justify-end items-center">
      <div className="flex items-center justify-center cg-text-warning gap-1">
        <ExclamationTriangleIcon className="w-5 h-5" />
        <span>Not enough Spark in Safe</span>
      </div>
      <span className="cg-text-md-500 cg-text-main">20.000</span>
    </div>
  </div>;
}

type HistoryPaymentProps = {
  transaction: Models.Premium.Transaction;
};

const HistoryPayment: React.FC<HistoryPaymentProps> = ({ transaction }) => {
  // relevant transactions for community are of type
  // 'user-donate-community', 'community-spend' and 'platform-donation'
  const { data, amount, userId, createdAt } = transaction;
  const { isMobile } = useWindowSizeContext();

  const user = useUserData(data.type === 'user-donate-community' ? (userId || undefined) : undefined);

  let content: React.JSX.Element;
  let sign: '+' | '-' | '' = '';
  let datePrefix = '';
  if (data.type === 'user-donate-community') {
    sign = '+';
    content = <>
      <div className="cg-bg-subtle h-10 w-10 cg-border-m flex items-center justify-center cg-heading-3">
        🫴
      </div>
      <div className="flex items-center flex-1">
        <span>Donated by </span>
        {user ? <UserTag userData={user} hideStatus jdenticonSize="20" noOfflineDimming /> : 'Loading...'}
      </div>
    </>;
  }
  else if (data.type === 'community-spend') {
    sign = '-';
    const { featureName } = data;
    if (featureName === 'URL_CHANGE') datePrefix = 'Bought ';
    else if (data.triggeredBy !== 'MANUAL') datePrefix = 'Auto-Renewed ';
    else datePrefix = 'Subscribed ';

    content = <>
      <div className="cg-bg-subtle h-10 w-10 cg-border-m">
        {getTierIcon(featureName)}
      </div>
      <span className="flex-1">{getTierTitle(featureName)}</span>
    </>;
  }
  else if (data.type === 'platform-donation') {
    sign = '+';
    content = <>
      <div className="cg-bg-subtle h-10 w-10 cg-border-m flex items-center justify-center cg-heading-3">
        {data.emoji}
      </div>
      <span className="flex-1">{data.text}</span>
    </>;
  }
  else {
    content = <span>No renderer for transaction type {data.type}</span>;
  }

  return (
    <div className={`flex p-4 gap-2 cg-text-secondary${isMobile ? ' flex-col' : ''}`}>
      <div className="flex items-center gap-1 flex-1">
        {content}
      </div>
      <div className="flex items-center gap-1">
        <span>{datePrefix}{dayjs(createdAt).format('MMM D, YYYY')}</span>
        <span className="cg-text-md-500 cg-text-main py-2 px-1">{sign}{amount.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default React.memo(BillingTab);