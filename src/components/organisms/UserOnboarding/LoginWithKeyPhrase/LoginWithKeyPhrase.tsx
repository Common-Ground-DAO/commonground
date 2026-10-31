// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightIcon } from "@heroicons/react/20/solid";

import loginManager from 'data/appstate/login';

import Button from "components/atoms/Button/Button";
import { useLoginWithKeyphraseContext } from "context/LoginWithKeyphraseProvider";
import { useWindowSizeContext } from "context/WindowSizeProvider";

import KeyStringRenderer from "../KeyPhrase/KeyStringRenderer";

import './LoginWithKeyPhrase.css';

// The deprecated 12-word recovery phrase login: legacy CG ID (gateway)
// instances only (AuthFlow offers it under "More" there).

const MNEMONIC_LENGTH = 12;

export type KeyPhraseInputType = { [id: number]: string };

type ButtonProps = {
    success: () => void;
}

export function LoginWithKeyPhraseStatus() {
    const { isMobile } = useWindowSizeContext();
    const { inputKeys, setInputKeys, error, setError } = useLoginWithKeyphraseContext();

    const handleKeyInput = useCallback((value: string, id: number) => {
        const inputKeysCopy: KeyPhraseInputType = { ...inputKeys };
        inputKeysCopy[id] = value;
        setInputKeys(inputKeysCopy);
        setError('');
    }, [inputKeys, setInputKeys, setError]);

    const handleOnPaste = useCallback((ev: React.ClipboardEvent<HTMLInputElement>) => {
        ev.preventDefault();
        const pastedString = ev.clipboardData.getData("text");
        const pastedArr = pastedString.split(" ")
        if (pastedArr.length === MNEMONIC_LENGTH) {
            const inputKeysCopy: KeyPhraseInputType = { ...inputKeys };
            pastedArr.forEach((value: string, key: number) => {
                inputKeysCopy[key + 1] = value;
            });
            setInputKeys(inputKeysCopy);
        }
    }, [inputKeys, setInputKeys]);

    

    return (
        <div className="keyphrase-login">
            <div className="grid grid-flow-row grid-cols-1 gap-8">
                <div className='grid grid-flow-row items-center justify-center justify-items-center gap-2 px-4'>
                    <span className='cg-heading-2 my-8'>Continue with Keyphrase</span>
                    <span className='cg-text-lg-400 text-center'>Please enter your 12-word keyphrase. You can simply paste into the first field to paste all words.</span>
                </div>
                <div className={`mnemonic-container ${isMobile ? 'mobile' : 'desktop'}`}>
                    {
                        [...Array(MNEMONIC_LENGTH || 12)].map((keyString: string, key: number) => (
                            <KeyStringRenderer
                                id={key + 1}
                                keyString={inputKeys[key + 1] || ''}
                                value={inputKeys[key + 1] || ''}
                                key={key}
                                hidden
                                onChange={handleKeyInput}
                                onPaste={handleOnPaste}
                            />
                        ))
                    }
                </div>
                {error && <div className="cg-text-error mb-8 text-center">{error}</div>}
            </div>
        </div>
    )
}

export function LoginWithKeyPhraseButton(props: ButtonProps) {
    const { inputKeys, error, setError } = useLoginWithKeyphraseContext();
    const [isLoading, setIsLoading] = useState(false);

    const mnemonic = useMemo(() => {
        const inputValues = Object.values(inputKeys);
        const hasEmptyValue = inputValues.length !== MNEMONIC_LENGTH || inputValues.some(value => !value.replace(/^\s+|\s+$/gm, ''));
        if (!hasEmptyValue) {
            const keyphrase = Object.values(inputKeys).join(" ").trim();
            const mnemonic = keyphrase.toLowerCase().replace(/ +/, ' ').trim();
            return mnemonic;
        }
        return undefined;
    }, [inputKeys]);

    const onFinish = React.useCallback(async () => {
        try {
            if (mnemonic) {
                setIsLoading(true);
                const mnemonicResult = await loginManager.prepareMnemonicLogin(mnemonic);
                if (mnemonicResult.readyForLogin) {
                    props.success();
                }
                else {
                    console.error("Mnemonic not ready for login", mnemonicResult);
                    throw new Error("Mnemonic not ready for login");
                }
            }
        } catch (e) {
            console.error("Error loggin in", e);
            setError("Error logging in");
            setIsLoading(false);
        }
    }, [mnemonic]);

    return (
        <Button
            role="primary"
            className="w-full cg-text-lg-500"
            text="Login"
            iconRight={<ArrowRightIcon />}
            disabled={!mnemonic}
            loading={isLoading}
            onClick={() => onFinish()}
        />
    )
}