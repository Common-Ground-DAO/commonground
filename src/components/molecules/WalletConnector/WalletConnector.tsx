// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Tooltip } from 'components/atoms/Tooltip/Tooltip';
import Button from 'components/atoms/Button/Button';

import MetamaskIcon from 'components/atoms/icons/24/MetamaskIcon.svg?react';

import "./WalletConnector.css";

export default function WalletConnector(props: {
  activeAddress: Common.Address | undefined;
  connect: () => void;
}) {
  const { activeAddress, connect } = props;

  const disabled = !!activeAddress;

  if (disabled) {
    return (
      <Tooltip
        tooltipContent={`This wallet is already connected. If you want to connect another wallet from Metamask, please open the Metamask application and select a different wallet there.`}
        triggerContent={
          <Button role="borderless" iconLeft={<MetamaskIcon />} text="Metamask" className="wallet-connect-btn" disabled={true} />
        }
        placement="top"
        triggerClassName="wallet-connector wallet-connector-disabled"
      />
    )
  }

  return (
    <div className="wallet-connector" onClick={() => connect()}>
      <Button role="borderless" iconLeft={<MetamaskIcon />} text="Metamask" className="wallet-connect-btn" />
    </div>
  )
}
