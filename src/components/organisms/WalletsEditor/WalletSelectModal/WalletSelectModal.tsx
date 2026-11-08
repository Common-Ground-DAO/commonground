// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useMemo, useState } from "react";

import Button from "../../../../components/atoms/Button/Button";
import Modal from "../../../atoms/Modal/Modal";
import { Tooltip } from "../../../../components/atoms/Tooltip/Tooltip";

import MetamaskIcon from '../../../../components/atoms/icons/24/MetamaskIcon.svg?react';

import signatureHelper, { MetamaskData } from '../../../../util/signatureHelper';

import "./WalletSelectModal.css";


type Properties = {
  hideModal: () => void;
  onWalletConnect: () => void;
}

export default function WalletSelectModal(props: Properties) {
  const { hideModal, onWalletConnect } = props;
  const [ activeAddress, setActiveAddress ] = useState<Common.Address | undefined>(signatureHelper.getMetamaskData().account);
  const [ isError, setIsError ] = useState<string>();
  const [ isLoading, setIsLoading ] = useState<boolean>(false);

  const connect = useMemo(() => {
    return async () => {
      setIsLoading(true);
      try {
        await signatureHelper.connectMetamask();
        onWalletConnect();
      } catch (e) { 
        if (e instanceof Error) {
          setIsError(e.message);
        } else {
          setIsError('Unknown error on connect to Metamask');
        }
      }
      setIsLoading(false);
    };
  }, [onWalletConnect])

  useEffect(() => {
    setIsError('');
    const listener = (data: MetamaskData) => {
      setActiveAddress(data.account);
    };
    signatureHelper.addMetamaskAccountChangeListener(listener);
    return () => {
      signatureHelper.removeMetamaskAccountChangeListener(listener);
    }
  }, [])


  if (isLoading && !isError) {
    return (
      <Modal hideHeader modalInnerClassName="text-only-modal">
        <div className="wallet-connecting-modal">
          <Button loading role="borderless" className="connecting-btn" />
          <p>Connecting...</p>
          <Button role="textual" text="Cancel" onClick={() => { hideModal(); }} />
        </div>
      </Modal>
    )
  }

  if (!isLoading && isError) {
    return (
      <Modal hideHeader modalInnerClassName="text-only-modal">
        <div className="wallet-connecting-modal">
          <p>{isError}</p>
          <Button role="textual" text="OK" onClick={hideModal} />
        </div>
      </Modal>
    )
  }

  return (
    <Modal headerText="Select your wallet provider" close={hideModal} modalInnerClassName="wallet-select-modal">
      <div className='wallet-select-container'>
        {!activeAddress && <Button role="secondary" onClick={connect} iconLeft={<MetamaskIcon />} text="Metamask" />}
        {!!activeAddress &&
          <Tooltip
            tooltipContent={`This wallet is already connected. If you want to connect another wallet from Metamask, please open the Metamask application and select a different wallet there.`}
            triggerContent={<Button role="secondary" iconLeft={<MetamaskIcon />} text="Metamask" disabled={true} />}
            placement="top"
          />
        }

      </div>
    </Modal>
  )
}