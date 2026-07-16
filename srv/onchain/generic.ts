// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ethers } from 'ethers';
import { OnchainPriority } from './scheduler';
import settings from './settings';
import errors from '../common/errors';
import { getBeneficiary, getPayableTokens, getSparkBonusPercentByAmount } from '../common/premiumConfig';
import { getStakingConfig } from '../util/stakingConfig';
import stakingHelper, { type StakedEvent, type UnstakedEvent } from '../repositories/staking';
import LogHelper from './loghelper';
import detectContractType from "./detectContract";
import {
  IERC20Metadata_abi_with_events,
  IERC721Metadata_abi_with_events,
  IERC1155MetadataURI_abi_with_events,
  LSP7_abi,
  LSP8_abi,
  IERC725Y_abi_with_events,
} from "./abis";
import onchainHelper from '../repositories/onchain';
import walletHelper from '../repositories/wallets';
import redisManager from '../redis';
import { checkRoleClaimability } from './index';
import ethereumApi from './ethereumApi';
import userHelper from '../repositories/users';
import { getUniversalProfileData } from './lukso';
import axios from '../util/axios';
import fileHelper from '../repositories/files';
import contractHelper from '../repositories/contracts';
import { addressRegex } from '../common/util';

const banError = `This query has created an error and cannot be repeated for ${settings.BAN_TIME / 1000} seconds`;
const stakingIface = new ethers.Interface([
  'event Staked(address indexed owner, uint256 indexed positionId, uint256 amount, uint64 stakedAt, uint64 unlockAt)',
  'event Unstaked(address indexed owner, uint256 indexed positionId, uint256 amount)',
]);

const erc20iface = new ethers.Interface(IERC20Metadata_abi_with_events);
const erc721iface = new ethers.Interface(IERC721Metadata_abi_with_events);
const erc1155iface = new ethers.Interface(IERC1155MetadataURI_abi_with_events);
const lsp7iface = new ethers.Interface(LSP7_abi);
const lsp8iface = new ethers.Interface(LSP8_abi);
const erc725iface = new ethers.Interface(IERC725Y_abi_with_events);

export default class GenericConnector implements Models.Server.OnchainConnector {
  private chain: Models.Contract.ChainIdentifier;
  private banlist = new Set<string>();
  private logHelper: LogHelper;
  private logCounter = 0;
  private contractListeners = new Map<string, (log: ethers.Log) => void>();
  private eventListeningRunning = false;
  private nextGetLogsTimer: any;
  private premiumContracts: Set<Common.Address> = new Set();
  private specialContracts: Map<Common.Address, Models.Wallet.ContractWalletData> = new Map();
  private nativePremiumAllowed = false;
  private premiumContractMap = new Map<Common.Address, Models.Contract.Data>();
  private premiumBeneficiaryAddress?: Common.Address;
  private premiumEvents = [] as {
    tokenAddress: Common.Address | 'native';
    blockNumber: number;
    txHash: string;
    sender: Common.Address;
    amount: bigint;
  }[];
  private stakingAddress?: Common.Address;
  private stakingEvents = [] as (
    | { kind: 'staked'; event: StakedEvent }
    | { kind: 'unstaked'; event: UnstakedEvent }
  )[];

  constructor(chain: Models.Contract.ChainIdentifier) {
    this.chain = chain;
    this.logHelper =  new LogHelper(chain);

    this.erc20Handler = this.erc20Handler.bind(this);
    this.erc721Handler = this.erc721Handler.bind(this);
    this.erc1155Handler = this.erc1155Handler.bind(this);
    this.lsp7Handler = this.lsp7Handler.bind(this);
    this.lsp8Handler = this.lsp8Handler.bind(this);
    this.universalProfileHandler = this.universalProfileHandler.bind(this);
    this._getLogsInterval = this._getLogsInterval.bind(this);
  }

  public startEventListener() {
    if (!this.eventListeningRunning) {
      this.eventListeningRunning = true;
      (async() => {
        // an unhandled rejection here kills the whole onchain process
        let _chain: (Models.Contract.ChainIdentifier | "hardhat") = this.chain as any;
        if (
          _chain === "hardhat" ||
          _chain === "eth" ||
          _chain === "xdai" ||
          _chain === "base"
        ) {
          this.premiumBeneficiaryAddress = getBeneficiary(_chain);
          const premiumTokens = getPayableTokens(_chain);
          for (const premiumToken of premiumTokens) {
            if (premiumToken.address === 'native') {
              this.nativePremiumAllowed = true;
            }
            else {
              let contractData: Models.Contract.Data | null = null;
              let dbResult = await contractHelper.getContractDataByParamsNoFetch(this.chain, premiumToken.address);
              if (dbResult) {
                this.premiumContractMap.set(premiumToken.address, dbResult);
                contractData = dbResult;
              }
              if (!contractData) {
                // must never crash the process: on instances without working
                // RPC endpoints (or unreachable contracts) premium payments
                // are simply unavailable
                const fetchResult = await this.contractData(premiumToken.address, OnchainPriority.HIGH).catch(() => null);
                if (!fetchResult) {
                  console.error(`ERROR: Could not get contract data for premium token ${premiumToken.address} on chain ${this.chain}`);
                }
                else {
                  const idRow = await contractHelper.createContract(this.chain, premiumToken.address, fetchResult.data);
                  contractData = {
                    ...fetchResult,
                    id: idRow.id,
                  };
                  this.premiumContractMap.set(premiumToken.address, contractData);
                }
              }
              if (contractData) {
                this.premiumContracts.add(premiumToken.address);
                if (!this.contractListeners.has(premiumToken.address)) {
                  // no other listener was registered yet, bind without erc20Handler call
                  this.contractListeners.set(premiumToken.address, this.premiumPaymentHandler.bind(this, false));
                }
                else {
                  // another listener was registered already, bind with erc20Handler call
                  this.contractListeners.set(premiumToken.address, this.premiumPaymentHandler.bind(this, true));
                }
              }
            }
          }
        }

        const stakingConfig = getStakingConfig();
        if (!!stakingConfig && stakingConfig.chain === this.chain) {
          this.stakingAddress = stakingConfig.contractAddress;
          console.log(`GenericConnector[${this.chain}]: watching staking contract ${this.stakingAddress}`);
        }

        const contractWallets = await walletHelper._getAllContractWalletsByChain(this.chain);
        if (this.chain === 'lukso') {
          for (const contractWallet of contractWallets) {
            if (!!contractWallet.signatureData.contractData) {
              this.watchSpecialContract(
                contractWallet.signatureData.contractData,
                contractWallet.walletIdentifier as Common.Address,
              );
            }
          }
        }
        this._getLogsInterval();
      })().catch((e) => {
        console.error(`Event listener setup failed for chain ${this.chain}, continuing without it`, e);
      });
    }
  }

  private async _getLogsInterval() {
    try {
      const { chain } = this;
      const [
        chainData,
        endBlockTmp,
      ] = await Promise.all([
        onchainHelper.getChainData(chain),
        ethereumApi.requestData('getBlockNumber', {
          chain: chain,
          priority: OnchainPriority.HIGH,
          retry: true,
        }).then(result => result.blockNumber - settings[chain].SAFE_BLOCK_DELAY),
      ]);
      
      if (!chainData || chainData.lastBlock < endBlockTmp) {
        const startBlock = !!chainData ? chainData.lastBlock + 1 : endBlockTmp;
        // do not fetch more than 20 batches at once
        const endBlock = Math.min(endBlockTmp, startBlock + settings[chain].BLOCK_BATCHSIZE * 20);
        let i = startBlock;
        while (i <= endBlock) {
          const fromBlock = i;
          const toBlock = Math.min(i + settings[chain].BLOCK_BATCHSIZE - 1, endBlock);
          try {
            const { logs } = await ethereumApi.requestData('getLogs', {
              chain,
              fromBlock,
              toBlock,
              priority: OnchainPriority.HIGH,
              retry: true,
            });
            i = toBlock + 1;
            for (const log of logs) {
              const addressLower = log.address.toLowerCase();
              // deliberately outside contractListeners: the map can be
              // rebound by contract-type detection, the staking watch must
              // never be displaced
              if (addressLower === this.stakingAddress) {
                this.handleStakingLog(log);
              }
              const listener = this.contractListeners.get(addressLower);
              if (!!listener) {
                listener(log);
              }
            }
            // must complete before lastBlock advances: a failure here breaks
            // the loop and the batch is retried next interval (repository
            // writes are idempotent, so re-delivery is safe)
            await this.flushStakingEvents();
            await onchainHelper.setChainData(chain, {
              lastBlock: toBlock
            });
          } catch (e) {
            console.warn(
              `${chain}: Error in chain update loop\n` +
              `Overall block range: ${startBlock} to ${endBlock}\n` +
              `Currently fetching: ${fromBlock} to ${toBlock}\n` +
              `Actual error:`, e
            );
            break;
          }
        }

        if (this.nativePremiumAllowed) {
          for (let i = startBlock; i <= endBlock; i++) {
            const { transactions } = await ethereumApi.requestData('getBlockTransactions', {
              chain,
              blockNumber: i,
              priority: OnchainPriority.HIGH,
              retry: true,
            });
            for (const tx of transactions) {
              const to = tx.to?.toLowerCase() || null;
              const amount = BigInt(tx.value);
              const gasLimit = BigInt(tx.gasLimit);
              if (!this.premiumBeneficiaryAddress) {
                console.error(`No beneficiary address set for chain ${this.chain}, this means no premium payments!`);
              }
              if (to === this.premiumBeneficiaryAddress && amount > 0n) { // gasLimit <= 21001n WON'T WORK for all chains!
                this.premiumEvents.push({
                  tokenAddress: 'native',
                  txHash: tx.txHash,
                  blockNumber: i,
                  sender: tx.from.toLowerCase() as Common.Address,
                  amount,
                });
              }
            }
          }
        }
      }

      if (this.premiumEvents.length > 0) {
        const premiumEvents = this.premiumEvents.splice(0);
        console.log(`${this.chain}: PREMIUM EVENTS`, premiumEvents);
        for (const premiumEvent of premiumEvents) {
          const walletOwner = await walletHelper.getWalletOwnerId(premiumEvent.sender);
          if (walletOwner) {
            let decimals = 18;
            if (premiumEvent.tokenAddress !== 'native') {
              const contractData = this.premiumContractMap.get(premiumEvent.tokenAddress);
              if (!contractData) {
                console.error(`Could not find contract data for premium token ${premiumEvent.tokenAddress} on chain ${chain}, skipping event...`);
                continue;
              }
              else if (contractData.data.type !== 'ERC20') {
                console.error(`Premium token ${premiumEvent.tokenAddress} is not an ERC20 token on chain ${chain}, skipping event...`);
                continue;
              }
              else {
                decimals = contractData.data.decimals;
              }
            }
            let tokenAmount = Math.round(Number(ethers.formatUnits(premiumEvent.amount, decimals)) * 1000);
            const bonusPercent = getSparkBonusPercentByAmount(tokenAmount);
            if (bonusPercent > 0) {
              tokenAmount = Math.round(tokenAmount * (1 + (bonusPercent / 100)));
            }

            console.log(`Giving ${tokenAmount} tokens to ${walletOwner}`);
            await userHelper.pointsBought({
              userId: walletOwner,
              amount: tokenAmount,
              blockNumber: premiumEvent.blockNumber,
              chain,
              txHash: premiumEvent.txHash,
              senderAddress: premiumEvent.sender,
              tokenAddress: premiumEvent.tokenAddress,
            });
          }
          else {
            console.error(`Could not find owner for wallet ${premiumEvent.sender} in chain ${chain}`);
          }
        }
      }

      if (this.logCounter > 0) {
        console.log(`GenericConnector[${chain}]: Processing ${this.logCounter} events of watched contracts`);
        this.logCounter = 0;
        const result = await this.logHelper.flush();
        const potentiallyLostAccess = await walletHelper.getRoleAccessByWalletsAndContracts(chain, result.updated);
        const onlineUsers = new Set<string>(await redisManager.userData.intersectWithOnlineUsers([
          ...potentiallyLostAccess.map(o => o.userId)
        ]));
  
        if (potentiallyLostAccess.length > 0) {
          console.log(new Date().toISOString());
          console.log(`Onchain[${chain}] Cron: Check for loss of roles`, potentiallyLostAccess);
        }
        for (const item of potentiallyLostAccess) {
          if (item.assignmentRules.type === "token") {
            checkRoleClaimability(
              item.userId,
              item.roleId,
              item.assignmentRules,
              onlineUsers.has(item.userId) ? OnchainPriority.MEDIUM : OnchainPriority.LOW
            );
          }
        }
      }

    } catch (e) {
      console.error(`${this.chain}: Error in getLogsInterval`, e);
    } finally {
      this.nextGetLogsTimer = setTimeout(this._getLogsInterval, settings[this.chain].UPDATE_INTERVAL);
    }
  }

  private handleStakingLog(log: ethers.Log) {
    try {
      const event = stakingIface.parseLog(log as any);
      if (!event) return;
      if (event.name === 'Staked') {
        const [owner, positionId, amount, stakedAt, unlockAt] = event.args;
        this.stakingEvents.push({
          kind: 'staked',
          event: {
            chain: this.chain,
            contractAddress: log.address.toLowerCase() as Common.Address,
            ownerAddress: (owner as string).toLowerCase() as Common.Address,
            positionId: positionId as bigint,
            amount: amount as bigint,
            stakedAt: new Date(Number(stakedAt) * 1000),
            unlockAt: new Date(Number(unlockAt) * 1000),
            txHash: log.transactionHash,
            logIndex: log.index,
          },
        });
      }
      else if (event.name === 'Unstaked') {
        const [owner, positionId] = event.args;
        this.stakingEvents.push({
          kind: 'unstaked',
          event: {
            chain: this.chain,
            contractAddress: log.address.toLowerCase() as Common.Address,
            ownerAddress: (owner as string).toLowerCase() as Common.Address,
            positionId: positionId as bigint,
            txHash: log.transactionHash,
          },
        });
      }
    } catch (e) {
      // logs from the watched address that do not match the ABI are ignored
    }
  }

  private async flushStakingEvents() {
    if (this.stakingEvents.length === 0) return;
    const events = this.stakingEvents.splice(0);
    console.log(`GenericConnector[${this.chain}]: Processing ${events.length} staking events`);
    try {
      // in log order, so a Staked is recorded before an Unstaked of the
      // same position within one batch
      for (const item of events) {
        if (item.kind === 'staked') {
          await stakingHelper.recordStaked(item.event);
        } else {
          await stakingHelper.recordUnstaked(item.event);
        }
      }
    } catch (e) {
      // no re-buffering: the batch retry re-fetches the same logs and
      // re-delivers the events; unshifting here would double-buffer them
      throw e;
    }
  }

  private premiumPaymentHandler(callErc20Handler: boolean, log: ethers.Log) {
    try {
      const event = erc20iface.parseLog(log as any);
      // Transfer(from: string, to: string, amount: bigint)
      if (
        !!event &&
        event.name === "Transfer" &&
        event.args.length === 3 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        typeof event.args[2] === "bigint"
      ) {
        if (!this.premiumBeneficiaryAddress) {
          console.error(`No beneficiary address set for chain ${this.chain}, this means no premium payments!`);
        }
        const receiver = event.args[1].toLowerCase();
        if (receiver === this.premiumBeneficiaryAddress) {
          this.premiumEvents.push({
            tokenAddress: log.address.toLowerCase() as Common.Address,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            sender: event.args[0].toLowerCase() as Common.Address,
            amount: event.args[2],
          });
        }
        if (callErc20Handler) {
          this.erc20Handler(log);
        }
      } else if (!!event && event.name === "Transfer") {
        console.error("Payment event not correctly detected - check ERC20 detection", event);
      }
    } catch (e) {}
  }

  private erc20Handler(log: ethers.Log) {
    try {
      const event = erc20iface.parseLog(log as any);
      // Transfer(from: string, to: string, amount: bigint)
      if (
        !!event &&
        event.name === "Transfer" &&
        event.args.length === 3 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        typeof event.args[2] === "bigint"
      ) {
        this.logCounter++;
        this.logHelper.handleTransfer({
          type: 'ERC20',
          blockNumber: log.blockNumber,
          contractAddress: log.address.toLowerCase() as Common.Address,
          from: event.args[0].toLowerCase() as Common.Address,
          to: event.args[1].toLowerCase() as Common.Address,
          amount: event.args[2],
        });
      } else if (!!event && event.name === "Transfer") {
        console.error("Event not correctly detected - check ERC20 detection", event);
      }
    } catch (e) {}
  }

  private erc721Handler(log: ethers.Log) {
    try {
      const event = erc721iface.parseLog(log as any);
      // Transfer(from: string, to: string, tokenId: bigint)
      if (
        !!event &&
        event.name === "Transfer" &&
        event.args.length === 3 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        typeof event.args[2] === "bigint"
      ) {
        this.logCounter++;
        this.logHelper.handleTransfer({
          type: 'ERC721',
          blockNumber: log.blockNumber,
          contractAddress: log.address.toLowerCase() as Common.Address,
          from: event.args[0].toLowerCase() as Common.Address,
          to: event.args[1].toLowerCase() as Common.Address,
          tokenId: event.args[2],
        });
      } else if (!!event && event.name === "Transfer") {
        console.error("Event not correctly detected - check ERC721 detection", event);
      }
    } catch (e) {}
  }

  private erc1155Handler(log: ethers.Log) {
    try {
      const event = erc1155iface.parseLog(log as any);
      // TransferSingle(operator: string, from: string, to: string, id: bigint, value: bigint)
      if (
        !!event &&
        event.name === "TransferSingle" &&
        event.args.length === 5 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        (typeof event.args[2] === "string" && !!event.args[2].match(addressRegex)) &&
        typeof event.args[3] === "bigint" &&
        typeof event.args[4] === "bigint"
      ) {
        this.logCounter++;
        this.logHelper.handleTransfer({
          type: 'ERC1155',
          blockNumber: log.blockNumber,
          contractAddress: log.address.toLowerCase() as Common.Address,
          from: event.args[1].toLowerCase() as Common.Address,
          to: event.args[2].toLowerCase() as Common.Address,
          tokenIds: [event.args[3]],
          values: [event.args[4]],
        });
      
      // TransferBatch(operator: string, from: string, to: string, ids: bigint[], values: bigint[])
      } else if (
        !!event &&
        event.name === "TransferBatch" &&
        event.args.length === 5 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        (typeof event.args[2] === "string" && !!event.args[2].match(addressRegex)) &&
        (Array.isArray(event.args[3]) && typeof event.args[3][0] === "bigint") &&
        (Array.isArray(event.args[4]) && typeof event.args[4][0] === "bigint")
      ) {
        this.logCounter++;
        this.logHelper.handleTransfer({
          type: 'ERC1155',
          blockNumber: log.blockNumber,
          contractAddress: log.address.toLowerCase() as Common.Address,
          from: event.args[1].toLowerCase() as Common.Address,
          to: event.args[2].toLowerCase() as Common.Address,
          tokenIds: event.args[3],
          values: event.args[4],
        });
      } else if (!!event && (event.name === "TransferSingle" || event.name === "TransferBatch")) {
        console.error("Event not correctly detected - check ERC1155 detection", event);
      }
    } catch (e) {}
  }

  private lsp7Handler(log: ethers.Log) {
    try {
      const event = lsp7iface.parseLog(log as any);
      // Transfer(operator: string, from: string, to: string, amount: bigint, force: boolean, data: string)
      if (
        !!event &&
        event.name === "Transfer" &&
        event.args.length === 6 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        (typeof event.args[2] === "string" && !!event.args[1].match(addressRegex)) &&
        typeof event.args[3] === "bigint" &&
        typeof event.args[4] === "boolean" &&
        typeof event.args[5] === "string"
      ) {
        this.logCounter++;
        this.logHelper.handleTransfer({
          type: 'LSP7',
          blockNumber: log.blockNumber,
          contractAddress: log.address.toLowerCase() as Common.Address,
          from: event.args[1].toLowerCase() as Common.Address,
          to: event.args[2].toLowerCase() as Common.Address,
          amount: event.args[3],
        });
      } else if (!!event && event.name === "Transfer") {
        console.error("Event not correctly detected - check LSP7 detection", event);
      }
    } catch (e) {}
  }

  private lsp8Handler(log: ethers.Log) {
    try {
      const event = lsp8iface.parseLog(log as any);
      // Transfer(operator: string, from: string, to: string, tokenId: string, force: boolean, data: string)
      if (
        !!event &&
        event.name === "Transfer" &&
        event.args.length === 6 &&
        (typeof event.args[0] === "string" && !!event.args[0].match(addressRegex)) &&
        (typeof event.args[1] === "string" && !!event.args[1].match(addressRegex)) &&
        (typeof event.args[2] === "string" && !!event.args[1].match(addressRegex)) &&
        typeof event.args[3] === "string" &&
        typeof event.args[4] === "boolean" &&
        typeof event.args[5] === "string"
      ) {
        this.logCounter++;
        this.logHelper.handleTransfer({
          type: 'LSP8',
          blockNumber: log.blockNumber,
          contractAddress: log.address.toLowerCase() as Common.Address,
          from: event.args[1].toLowerCase() as Common.Address,
          to: event.args[2].toLowerCase() as Common.Address,
          tokenId: event.args[3],
        });
      } else if (!!event && event.name === "Transfer") {
        console.error("Event not correctly detected - check LSP8 detection", event);
      }
    } catch (e) {}
  }

  private __lsp3DataKey = ethers.keccak256(ethers.toUtf8Bytes("LSP3Profile"));
  private universalProfileHandler(log: ethers.Log) {
    try {
      const event = erc725iface.parseLog(log as any);
      // event DataChanged(bytes32 indexed dataKey, bytes dataValue)
      // DataChanged(dataKey: string, dataValue: string)
      if (
        !!event &&
        event.name === "DataChanged" &&
        event.args.length === 2 &&
        typeof event.args[0] === "string" &&
        typeof event.args[1] === "string"
      ) {
        if (event.args[0] === this.__lsp3DataKey) {
          console.log("Universal Profile " + log.address + " changed");
          getUniversalProfileData(this.chain, { data: { address: log.address.toLowerCase() as Common.Address }})
            .then(async (data) => {
              console.log("Retrieved updated universal profile data", data);

              let luksoImageId = null;
              if (data.profileImageUrl) {
                try {
                  console.log("Downloading LUKSO profile image");
                  const imageUrl =
                    data.profileImageUrl.startsWith("ipfs://") 
                    ? `https://ipfs.io/ipfs/${data.profileImageUrl.split('ipfs://').pop()}`
                    : data.profileImageUrl.replace("_normal", "");
                  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36' } });
                  const buffer = Buffer.from(response.data, "utf-8");
                  const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
                  luksoImageId = image.fileId;
                } catch (e) {
                  // For now just ignore error if this fails, but is this fine for now?
                  console.error("Could not download lukso image", e);
                }
              }

              return userHelper.updateUniversalProfileData({
                contractAddress: log.address.toLowerCase() as Common.Address,
                displayName: data.username,
                imageId: luksoImageId,
              });
            })
            .then(() => {
              console.log("Universal Profile data updated");
            })
            .catch(e => {
              console.error("Universal Profile data handling failed", e);
            });
        }
      } else if (!!event && event.name === "DataChanged") {
        console.error("Event not correctly detected - check Universal Profile detection", event);
      }
    }
    catch (e) {}
  }

  public watchContract(data: Omit<Models.Contract.Data, "id"> & Partial<Pick<Models.Contract.Data, "id">>) {
    if (data.chain !== this.chain) {
      console.warn(`GenericConnector[${this.chain}]: Received watch contract for foreign chain`);
    }
    else {
      // if premium contract, bind premiumPaymentHandler with callErc20Handler = true
      if (this.premiumContracts.has(data.address.toLowerCase() as Common.Address)) {
        this.contractListeners.set(data.address.toLowerCase(), this.premiumPaymentHandler.bind(this, true));
        return;
      }
      switch (data.data.type) {
        case "ERC20": {
          this.contractListeners.set(data.address.toLowerCase(), this.erc20Handler);
          break;
        }
        case "ERC721": {
          this.contractListeners.set(data.address.toLowerCase(), this.erc721Handler);
          break;
        }
        case "ERC1155": {
          this.contractListeners.set(data.address.toLowerCase(), this.erc1155Handler);
          break;
        }
        case "LSP7": {
          this.contractListeners.set(data.address.toLowerCase(), this.lsp7Handler);
          break;
        }
        case "LSP8": {
          this.contractListeners.set(data.address.toLowerCase(), this.lsp8Handler);
          break;
        }
      }
    }
  }

  public watchSpecialContract(data: Models.Wallet.ContractWalletData, address: Common.Address) {
    this.specialContracts.set(address.toLowerCase() as Common.Address, data);
    if (data.type === 'universal_profile') {
      console.log("Watching universal profile " + address);
      this.contractListeners.set(address.toLowerCase(), this.universalProfileHandler);
    }
  }

  public async contractData(contractAddress: Common.Address, priority: OnchainPriority) {
    if (this.banlist.has(contractAddress)) {
      throw new Error("Contract address is banlisted");
    }
    const contractDetectionResult = await detectContractType(this.chain, contractAddress, priority);
    const contractType = contractDetectionResult?.type || null;
    if (contractType === null) {
      this.banAddressTemporarily(contractAddress);
      throw new Error(errors.server.NOT_SUPPORTED);
    }

    switch (contractType) {
      case "ERC20": {
        const [
          namePromise,
          symbolPromise,
          decimalsPromise,
        ] = await Promise.allSettled([
          ethereumApi.requestData('ERC_20_contract.name', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: true,
          }),
          ethereumApi.requestData('ERC_20_contract.symbol', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: true,
          }),
          ethereumApi.requestData('ERC_20_contract.decimals', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: true,
          }),
        ]);
        if (decimalsPromise.status === 'rejected') {
          throw new Error(errors.server.NOT_SUPPORTED);
        }
        const contractData: Omit<Models.Contract.Data, "id"> = {
          address: contractAddress.toLowerCase() as Common.Address,
          chain: this.chain,
          data: {
            type: "ERC20" as "ERC20",
            name: namePromise.status === "fulfilled" ? namePromise.value.result : "",
            symbol: symbolPromise.status === "fulfilled" ? symbolPromise.value.result : "",
            decimals: Number(decimalsPromise.value.result),
          },
        };
        return contractData;
      }
      case "ERC721": {
        const [
          namePromise,
          symbolPromise,
        ] = await Promise.allSettled([
          ethereumApi.requestData('ERC_721_contract.name', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: true,
          }),
          ethereumApi.requestData('ERC_721_contract.symbol', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: true,
          }),
        ]);
        const contractData: Omit<Models.Contract.Data, "id"> = {
          address: contractAddress.toLowerCase() as Common.Address,
          chain: this.chain,
          data: {
            type: "ERC721" as "ERC721",
            name: namePromise.status === "fulfilled" ? namePromise.value.result : "",
            symbol: symbolPromise.status === "fulfilled" ? symbolPromise.value.result : ""
          },
        }
        return contractData;
      }
      case "ERC1155": {
        let name: string | undefined;
        try {
          // try requesting name from ERC1155, "abusing" the ERC20 interface
          const nameResult = await ethereumApi.requestData('ERC_20_contract.name', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: false,
          });
          name = nameResult.result;
        } catch (e) {}
        const contractData: Omit<Models.Contract.Data, "id"> = {
          address: contractAddress.toLowerCase() as Common.Address,
          chain: this.chain,
          data: {
            type: "ERC1155",
            name,
            withMetadataURI: contractDetectionResult?.isErc1155MetadataURI || false,
          }
        }
        return contractData;
      }
      case "LSP7":
      case "LSP8": {
        let decimalsPromise: Promise<number> | undefined;
        const metadataPromise = ethereumApi.requestData('ERC_725Y_contract.getDataBatch', {
          chain: this.chain,
          contractAddress,
          priority: OnchainPriority.HIGH,
          retry: true,
          keys: [
            'LSP4TokenName',
            'LSP4TokenSymbol',
            'LSP4TokenType',
          ],
        }).then((result) => {
          return {
            name: ethers.toUtf8String(result.values[0]),
            symbol: ethers.toUtf8String(result.values[1]),
            tokenType: Number(BigInt(result.values[2])),
          };
        });
        if (contractType === "LSP7") {
          decimalsPromise = ethereumApi.requestData('LSP_7_contract.decimals', {
            chain: this.chain,
            contractAddress,
            priority: OnchainPriority.HIGH,
            retry: true,
          }).then(({ result }) => result);
          const [
            metadataResult,
            decimalsResult,
          ] = await Promise.all([
            metadataPromise,
            decimalsPromise,
          ]);
          const contractData: Omit<Models.Contract.Data, "id"> = {
            address: contractAddress.toLowerCase() as Common.Address,
            chain: this.chain,
            data: {
              type: "LSP7" as "LSP7",
              name: metadataResult.name,
              symbol: metadataResult.symbol,
              decimals: decimalsResult,
              tokenType: metadataResult.tokenType,
            },
          }
          return contractData;
        }
        const metadataResult = await metadataPromise;
        const contractData: Omit<Models.Contract.Data, "id"> = {
          address: contractAddress.toLowerCase() as Common.Address,
          chain: this.chain,
          data: {
            type: "LSP8" as "LSP8",
            name: metadataResult.name,
            symbol: metadataResult.symbol,
            tokenType: metadataResult.tokenType,
          },
        }
        return contractData;
      }
    }
  }

  public async getBalance(
    address: Common.Address,
    contractData: Models.Contract.Data,
    gatingRule: Models.Community.GatingRule,
    priority: OnchainPriority
  ): Promise<{
    balance: bigint;
    blockHeight: number;
  }> {
    if (this.banlist.has(contractData.address)) {
      throw new Error(banError);
    }
    if (contractData.data.type !== gatingRule.type) {
      throw new Error("Gating rule is of different token type than contract");
    }
    switch (gatingRule.type) {
      case "ERC20": {
        const { result, blockNumber: blockHeight } = await ethereumApi.requestData('ERC_20_contract.balanceOf', {
          chain: this.chain,
          contractAddress: contractData.address,
          walletAddress: address,
          priority,
          retry: true,
        });
        return { balance: BigInt(result), blockHeight };
      }
      case "ERC721": {
        const { result, blockNumber: blockHeight } = await ethereumApi.requestData('ERC_721_contract.balanceOf', {
          chain: this.chain,
          contractAddress: contractData.address,
          walletAddress: address,
          priority,
          retry: true,
        });
        return { balance: BigInt(result), blockHeight };
      }
      case "ERC1155": {
        const { result, blockNumber: blockHeight } = await ethereumApi.requestData('ERC_1155_contract.balanceOf', {
          chain: this.chain,
          contractAddress: contractData.address,
          walletAddress: address,
          tokenId: gatingRule.tokenId,
          priority,
          retry: true,
        });
        return { balance: BigInt(result), blockHeight };
      }
      case "LSP7": {
        const { result, blockNumber: blockHeight } = await ethereumApi.requestData('LSP_7_contract.balanceOf', {
          chain: this.chain,
          contractAddress: contractData.address,
          walletAddress: address,
          priority,
          retry: true,
        });
        return { balance: BigInt(result), blockHeight };
      }
      case "LSP8": {
        const { result, blockNumber: blockHeight } = await ethereumApi.requestData('LSP_8_contract.balanceOf', {
          chain: this.chain,
          contractAddress: contractData.address,
          walletAddress: address,
          priority,
          retry: true,
        });
        return { balance: BigInt(result), blockHeight };
      }
    }
  }

  private banAddressTemporarily(address: string) {
    this.banlist.add(address);
    setTimeout(() => {
      this.banlist.delete(address);
    }, settings.BAN_TIME);
  }
}
