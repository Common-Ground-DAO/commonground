// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md


import React, { Dispatch, ReactNode, SetStateAction, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyPhraseInputType } from "../components/organisms/UserOnboarding/KeyPhrase/KeyPhraseConfirmation";
import { getUrl } from "common/util";

type LoginWithKeyphraseState = {
    inputKeys: KeyPhraseInputType;
    setInputKeys: Dispatch<SetStateAction<KeyPhraseInputType>>;
    handleLogin: () => Promise<void>;
    error: string | undefined;
    setError: Dispatch<SetStateAction<string | undefined>>;
}

export const LoginWithKeyphraseContext = React.createContext<LoginWithKeyphraseState>({
    inputKeys: {},
    setInputKeys: () => {},
    handleLogin: async () => {},
    error: undefined,
    setError: () => {}
});

export function LoginWithKeyphraseProvider(props: { children: ReactNode }) {
    const navigate = useNavigate();
    // const { switchAccount } = useConnectionContext();
    const [ inputKeys, setInputKeys ] = useState<KeyPhraseInputType>({});
    const [ error, setError ] = useState<string>();

    const handleLogin = async () => {
        try {
            const keyphrase = Object.values(inputKeys).join(" ").trim();
            if (!!keyphrase) {
                // await switchAccount(keyphrase);
                navigate(getUrl({type: 'home'}));
            }
        } catch (e) {
            if (e instanceof Error) {
                setError(e.message)
            } else {
                setError("An unknown error occurred");
            }
        }
    }

    return (
        <LoginWithKeyphraseContext.Provider value={{
            inputKeys,
            setInputKeys,
            handleLogin,
            error,
            setError
        }}>
          {props.children}
        </LoginWithKeyphraseContext.Provider>
    );
}

export function useLoginWithKeyphraseContext() {
    const context = React.useContext(LoginWithKeyphraseContext);
    return context;
}
