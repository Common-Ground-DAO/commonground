// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import signatureHelper, { MetamaskData } from '../../../util/signatureHelper';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';

import Button from '../../../components/atoms/Button/Button';
import { isLocalUrl } from '../../../components/atoms/SimpleLink/SimpleLink';
import Tag from '../../../components/atoms/Tag/Tag';

import CloseIcon from '../../../components/atoms/icons/16/Close.svg?react';
import GreenStatusIcon from '../../../components/atoms/icons/24/GreenStatus.svg?react';
import FractalLogoSrc from '../../../static/fractal.png';
import { useOwnUser } from 'context/OwnDataProvider';

import './IdentitiesEditor.css';

const fractalLink = `https://app.fractal.id/authorize?client_id=EqjSwxLh1Q8ZZpXXE7gBwxFVvYIZxhZuG0ykhTvxFsE&redirect_uri=https%3A%2F%2Fapp.cg%2F%3FfractalGranted%3Dtrue&response_type=code&scope=contact%3Aread%20verification.uniqueness%3Aread%20verification.uniqueness.details%3Aread%20verification.wallet-eth%3Aread%20verification.wallet-eth.details%3Aread`;
const digitalIdentityLink = 'https://app.cg/c/commonground/article/what-is-a-digital-identity-e6xSp44Ve9KX28CK3e73Pr/';

type Props = {
  metamaskData: MetamaskData;
}

export default function IdentitiesEditor(props: Props) {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { metamaskData } = props;
  const [ wallets, setWallets ] = useState<any[]>([]);

  const ownUser = useOwnUser();

  useEffect(() => {
    // ToDo:
    //const wallets = await userApi.getMyWallets()
    setWallets([]);
  }, []);

  const showBlocker = metamaskData.account === undefined && wallets.length === 0;

  const handleFractalClick = () => {
    if (!showBlocker) {
      window.open(fractalLink, "FractalAuth", "noreferrer");
    }
  };

  const handleFractalSignAndAdd = async () => {
    if (!showBlocker) {
      const signature = await signatureHelper.getFractalSignature();
      // Todo
      // await cgApi.write.addFractalID(signature);
    }
  };

  const handleRemoveFractalVerification = async () => {
    const signature = await signatureHelper.getFractalSignature();
    // Todo
    // await cgApi.write.removeFractalID(signature);
  };

  const FractalLogo = () => <img src={FractalLogoSrc} alt="fractal logo" />;

  const openDigitalIdentity = () => {
    const localExtract = isLocalUrl(digitalIdentityLink);
    if (localExtract) {
      navigate(localExtract);
    } else {
      if (isMobile) {
        window.open(digitalIdentityLink, 'infoTab', 'noreferrer');
      } else {
        window.open(digitalIdentityLink, '_blank', 'noreferrer');
      }
    }
  }

  return (
    <div className='identities-editor-container'>
      <div className={`identities-editor wallet-settings-section${showBlocker ? " blocked" : ""}`}>
          <div className="wallet-settings-section-title">
            <h3>Identities</h3>
            <Tag label="Anonymous and optional" variant="safe" />
          </div>

          {/*!!ownUser?.fractalId ? (
            <div className="wallet-settings-full-row fractal-info-row">
              <div className="flex items-center gap-1">
                <GreenStatusIcon />
                <FractalLogo />
                <span>Verified with Fractal</span>
              </div>
              <Button
                  onClick={handleRemoveFractalVerification}
                  iconLeft={<CloseIcon />}
              />
            </div>
          ) : (
            <div className="identities-container">
              <div className="flex w-full justify-between">
                <div className="flex items-center gap-2">
                  <FractalLogo />
                  <span>Fractal</span>
                </div>
                {!isMobile && <div className="grey-text-column fractal-disclaimer flex items-center"><div>A leading identity provider</div></div>}
              </div>
              <div className="identities-step">
                <h1>Step 1</h1>
                <p>
                Uniqueness check - a 30 second AI video call will confirm you are unique. No personal information or documents are required, this process is anonymous.
                It helps us keep Common Ground free from bots. Please use the same Metamask wallet on Fractal as you use on Common Ground.
                </p>
                <Button
                  role='primary'
                  onClick={handleFractalClick}
                  text='Start uniqueness check'
                  className='mt-2'
                  disabled={showBlocker}
                />
              </div>
              <div className="identities-step">
                <h1>Step 2</h1>
                <p>
                Common Ground needs access to your Fractal identity. You will be asked to sign with your wallet. This links your wallet to your account on Common Ground and proves that you are a human. We do not gain access to anything inside of your wallet.
                </p>
                <Button
                  role='primary'
                  onClick={handleFractalSignAndAdd}
                  text='Share Fractal Identity'
                  className='mt-2'
                  disabled={showBlocker}
                />
              </div>
            </div>
          )*/}
      </div>

      {showBlocker && <div className="identities-editor-blocker">
        <p>Connect a wallet to add a digital identity</p>
        <Tag variant='info' label='What is a digital identity?' onClick={openDigitalIdentity} />
      </div>}
    </div>
  );
}