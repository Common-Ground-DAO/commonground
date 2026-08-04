// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
// The Lukso UP extension injects a plain EIP-1193 provider on `window.lukso`.
// This used to go through ethers 5's `Web3Provider`; the raw provider is used
// directly now, deliberately *not* viem's wallet client — the login signature
// is produced with `eth_sign`, and viem's `signMessage` would send
// `personal_sign` instead, which the backend's verification would reject.
type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
};
import errors from "common/errors";
import userApi from "data/api/user";
import getSiweMessage from "util/siwe";

type UniversalProfileContextType = {
  universalProfileAddress: string | undefined;
  isConnected: boolean;
  hasExtension: boolean;
  isLoading: boolean;
  error: string | undefined;
  setError: React.Dispatch<React.SetStateAction<string | undefined>>;
  confirmOwnership: () => Promise<LoginData | undefined>;
  connectToUniversalProfile: () => void;
};

interface LoginData {
  address: string;
  signature: string;
  message: string;
}

declare global {
  interface Window {
    lukso: any;
  }
}

// Create a new context for the universal profile
export const UniversalProfileContext =
  createContext<UniversalProfileContextType>({
    universalProfileAddress: undefined,
    isConnected: false,
    hasExtension: false,
    isLoading: false,
    error: undefined,
    setError: () => {},
    confirmOwnership: () => Promise.resolve(undefined),
    connectToUniversalProfile: () => {},
  });

export const useUniversalProfile = () => useContext(UniversalProfileContext);

// Define the provider component
export const UniversalProfileProvider: React.FC<
  React.PropsWithChildren<{}>
> = ({ children }) => {
  const [luksoProvider, setLuksoProvider] = useState<Eip1193Provider | undefined>(undefined);
  // Initialize the profile state with null
  const [universalProfileAddress, setAddress] = useState<string | undefined>(
    undefined
  );
  const [hasExtension, setHasExtension] = useState(false);
  const [isLoading, setLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (window.lukso) {
      setLuksoProvider(window.lukso as Eip1193Provider);
      setHasExtension(true);
    } else {
      setHasExtension(false);
    }
  }, []);

  const connectToUniversalProfile = async () => {
    try {
      if (!luksoProvider) {
        throw new Error("No lukso provider found");
      }
      setLoading(true);
      const chainId = await luksoProvider.request({ method: "eth_chainId" });
      if (parseInt(chainId, 16) !== 42) {
        try {
          await luksoProvider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x2a" }],
          });
        } catch (error: any) {
          setError(error.message);
          return;
        }
      }
      const accounts: string[] = await luksoProvider.request({ method: "eth_requestAccounts" });
      try {
        const upAddress = accounts?.[0];
        if (upAddress) {
          setAddress(upAddress);
          setLoading(false);
          setIsConnected(true);
        } else {
          setLoading(false);
          setIsConnected(false);
        }
      } catch (e: any) {
        setLoading(false);
        setIsConnected(false);
        setError(e.message);
      }
    } catch (error: any) {
      setLoading(false);
      setError(error.message);
    }
  };

  const signWithUniversalProfile = useCallback(async () => {
    if (!luksoProvider) {
      throw new Error("No lukso provider found");
    }
    if (!universalProfileAddress) {
      throw new Error("No universal profile address found");
    }
    const secret = await userApi.getSignableSecret();
    let siweMessage = getSiweMessage({ address: universalProfileAddress as Common.Address, chainId: 42, secret });

    const signature: string = await luksoProvider.request({
      method: "eth_sign",
      params: [universalProfileAddress, siweMessage],
    });
    return { signature, siweMessage, secret };
  }, [universalProfileAddress, luksoProvider]);

  const confirmOwnership = useCallback(async () => {
    setLoading(true);
    if (!!universalProfileAddress) {
      try {
        const universalProfileSignature = await signWithUniversalProfile();

        if (universalProfileSignature) {
          setError(undefined);
          const luksoLoginData: LoginData = {
            address: universalProfileAddress,
            signature: universalProfileSignature.signature,
            message: universalProfileSignature.siweMessage,
          };
          setLoading(false);
          return luksoLoginData;
        } else {
          setLoading(false);
          throw new Error("Could not sign wallet, please try again");
        }
      } catch (e: any) {
        setLoading(false);
        if (e.code === 4001) {
          setError("You rejected the sign request");
        } else {
          if (e.message) {
            let message: string = e.message.toString();
            if (message) {
              // remove useless prefix
              message = message.replace("Error:", "");
            }
            if (message.includes(errors.server.LUKSO_USERNAME_NOT_FOUND)) {
              message = "No universal profile username found for that address";
            }
            setError(message);
          } else {
            setError(e);
          }
        }
      }
    } else {
      setLoading(false);
      setError("No universal profile address found");
      throw new Error("No universal profile address found");
    }
  }, [universalProfileAddress, signWithUniversalProfile]);

  return (
    <UniversalProfileContext.Provider
      value={{
        universalProfileAddress,
        hasExtension,
        isLoading,
        isConnected,
        error,
        setError,
        confirmOwnership,
        connectToUniversalProfile,
      }}
    >
      {children}
    </UniversalProfileContext.Provider>
  );
};
