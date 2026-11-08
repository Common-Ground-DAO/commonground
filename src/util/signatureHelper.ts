// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Address, SignableSecret, SignedData } from 'common/types';
// Plain EIP-1193, as injected by MetaMask (or returned by its SDK). This used
// to hold an ethers 5 `Web3Provider`, whose only use was `.send()` — i.e.
// `request()` under a different name.
type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  on?: (event: string, listener: (...args: any[]) => void) => void;
};
import config from '../common/config';

// MetaMask
export type MetamaskData = {
  account: Address | undefined;
  chainId: number;
};

class SignatureHelper {
  private metamaskAccount: Address | undefined;
  private metamaskChainId: number = 0;
  private metamaskAccountListeners = new Set<(data: MetamaskData) => void>();
  private provider: Eip1193Provider | undefined | null = undefined;
  
  constructor() {
    this.metamaskAccount = (window as any).ethereum?.selectedAddress || undefined;
    this.metamaskChainId = parseInt((window as any).ethereum?.chainId || "0x0", 16);
  }

  public async recoverSigner(data: SignableSecret, signature: string): Promise<string> {
    const { recoverTypedSignature, SignTypedDataVersion } = await import('@metamask/eth-sig-util');
    return recoverTypedSignature({data: data as any, signature, version: SignTypedDataVersion.V4}).toLowerCase();
  }

  public async connectMetamask() {
      // This used to instantiate `@metamask/sdk` and take its `getProvider()`,
      // then require it to be identical to `window.ethereum` — every path where
      // it was not threw below. So the SDK could only ever hand back what
      // `window.ethereum` already was, and the dependency (0.1.0, deprecated
      // and superseded by MetaMask Connect) is gone with the wagmi 2 migration.
      const provider = window.ethereum;
      if (provider) {
        const metamask: any = (window as any).ethereum;
        if (metamask === provider) {
          try {
            const accounts = await metamask.request({method: "eth_requestAccounts"});
            this.metamaskAccount = accounts[0].toLowerCase();
            this.metamaskChainId = parseInt(metamask.chainId, 16);
            this.notifyListeners();

            if (!this.provider) {
              this.provider = metamask as Eip1193Provider;
              metamask.on("accountsChanged", (accounts: string[]) => {
                if (accounts && accounts.length > 0) {
                  this.metamaskAccount = accounts[0].toLowerCase() as Address;
                } else {
                  this.metamaskAccount = undefined;
                }
                this.notifyListeners();
              });
              metamask.on("chainChanged", (chainId: string) => {
                this.metamaskChainId = parseInt(chainId, 16);
                this.notifyListeners();
              });
              metamask.on('connect', (connectInfo: { chainId: string }) => {
                this.metamaskChainId = parseInt(connectInfo.chainId, 16);
                this.notifyListeners();
              });
              metamask.on('disconnect', () => {
                this.metamaskAccount = undefined;
                this.metamaskChainId = 0;
                this.notifyListeners();
              });
            }
          } catch (e) {
            const message = !!e ? (e as any).message : "Metamask connection failed";
            throw new Error(message);
          }
        } else {
          throw new Error('Do you have multiple wallets installed?');          
        }
      } else {
        throw new Error('Please install MetaMask!'); 
      }
  }

  public getMetamaskData(): MetamaskData {
    return {
      account: this.metamaskAccount,
      chainId: this.metamaskChainId
    };
  }

  public addMetamaskAccountChangeListener(listener: (data: MetamaskData) => void) {
    this.metamaskAccountListeners.add(listener);
  }

  public removeMetamaskAccountChangeListener(listener: (data: MetamaskData) => void) {
    this.metamaskAccountListeners.delete(listener);
  }

  public async metamaskSignData(data: any) {
    if (!this.provider) {
      await this.connectMetamask();
    }
    if (!this.provider) {
      throw new Error("Metamask connection failed");
    }
    if (!this.metamaskAccount) {
      throw new Error("Given account not provided by metamask");
    }
    try {
      const signature: string = await this.provider.request({
        method: "eth_signTypedData_v4",
        params: [this.metamaskAccount, JSON.stringify(data)],
      });
      return { data, signature };
    } catch (e) {
      let message = !!e ? (e as any).message : "Metamask sign account failed";
      // remove useless prefix
      message = message.replace(/^[^:]+:\s*/,'');
      throw new Error(message);
    }
  }

  public async getFractalSignature() {
    const message = config.FRACTAL_TEXT;
    const account = this.metamaskAccount;
    if (!this.provider) {
      await this.connectMetamask();
    }
    const signature: string = await (window as any).ethereum.request({
      method: "personal_sign",
      params: [message, account]
    });
    return signature;
  }
  
  // PRIVATE
  private notifyListeners() {
    const listeners = Array.from(this.metamaskAccountListeners);
    const data = {
      account: this.metamaskAccount,
      chainId: this.metamaskChainId
    };
    for (const listener of listeners) {
      listener(data);
    }
  }
}

const signatureHelper = new SignatureHelper();
export default signatureHelper;
