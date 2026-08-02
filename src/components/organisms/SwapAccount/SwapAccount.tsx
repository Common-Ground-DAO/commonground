// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useConnectionContext } from "../../../context/ConnectionProvider";
import { useCopiedToClipboardContext } from "../../../context/CopiedToClipboardDialogContext";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import Button from "../../../components/atoms/Button/Button";
import KeyPhrase from "../UserOnboarding/KeyPhrase/KeyPhrase";
import TextAreaField from "../../molecules/inputs/TextAreaField/TextAreaField";
import UserSettingsHeader from "../../../components/molecules/UserSettingsHeader/UserSettingsHeader";

import ClipboardIcon from '../../../components/atoms/icons/20/Clipboard.svg?react';
import EyeIcon from '../../../components/atoms/icons/16/Eye.svg?react';
import EyeOffIcon from '../../../components/atoms/icons/16/EyeOff.svg?react';

import "./SwapAccount.css";

export default function SwapAccount() {
    // FIXME: Fix swap account

    return <div></div>
    // const { switchAccount, mnemonic } = useConnectionContext();
    // const { triggerCopiedToClipboardDialog } = useCopiedToClipboardContext();
    // const { isMobile } = useWindowSizeContext();
    // const [ mnemonicInput, setMnemonicInput ] = useState<string>('');
    // const [ isHidden, setHidden ] = useState(true);
    // const [ error, setError ] = useState<string>();
    // const navigate = useNavigate();

    // const newRandomAccount = async () => {
    //     try {
    //         await switchAccount();
    //         navigate('/');
    //     } catch (e) {
    //         if (e instanceof Error) {
    //             setError(e.message)
    //         } else {
    //             setError("An unknown error occurred");
    //         }
    //     }
    // }

    // const switchToExistingAccount = async () => {
    //     try {
    //         await switchAccount(mnemonicInput);
    //         navigate('/');
    //     } catch (e) {
    //         if (e instanceof Error) {
    //             setError(e.message)
    //         } else {
    //             setError("An unknown error occurred");
    //         }
    //     }
    // }

    // let errorDiv: JSX.Element | undefined;
    // if (error !== undefined) {
    //     errorDiv = (
    //         <div className="text-red-900 mb-4">
    //             {error}
    //         </div>
    //     );
    // }

    // const mnemonicArr: string[] = useMemo(() => {
    //     return mnemonic.split(" ");
    // }, [mnemonic]);

    // const handleClipboardClick = () => {
    //     triggerCopiedToClipboardDialog(mnemonic);
    // };

    // return (
    //     <div className="swap-account">
    //         <UserSettingsHeader title="Account" />

    //         <h3>Key phrase</h3>
    //         <p>Make sure this is backed up safely to log into your account from anywhere.</p>
    //         <div className="success-buttons">
    //             <Button role="secondary" text={isHidden ? 'Show key' : 'Hide key'} iconRight={isHidden ? <EyeIcon /> : <EyeOffIcon />} onClick={() => setHidden(!isHidden)} />
    //             <Button role="primary" text="Copy key" iconRight={<ClipboardIcon />} onClick={handleClipboardClick} />
    //         </div>
    //         <KeyPhrase mnemonic={mnemonicArr} hidden={isHidden} />
            
    //         <hr />

    //         <div className="flex flex-col items-stretch">
    //             <h3>Swap account</h3>
    //             <p>You can log into another account, please make sure you have your key phrase above backed up!</p>
    //             {errorDiv}
    //             <TextAreaField
    //                 value={mnemonicInput}
    //                 onChange={value => setMnemonicInput(value)}
    //                 placeholder="Enter your 12 word key phrase here to swap account"
    //                 rows={isMobile ? 2 : 1}
    //             />
    //             <div className="btnList align-center">
    //                 <Button
    //                     role="secondary"
    //                     text="Login"
    //                     className="btn-default mb-2"
    //                     onClick={switchToExistingAccount}
    //                     disabled={!mnemonicInput}
    //                 />
    //             </div>
    //         </div>

    //         <hr />

    //         <h3>Create new account</h3>
    //         <p>Please be aware that you can only have your human verification tied to one account at a time. That’s how we ensure users are unique!</p>
    //         <div className="btnList align-center mt-4">
    //             <Button
    //                 role="secondary"
    //                 text="Create new random account"
    //                 className="btn-default mb-2"
    //                 onClick={newRandomAccount}
    //             />
    //         </div>
    //     </div>
    // )
}