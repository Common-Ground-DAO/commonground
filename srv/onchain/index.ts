// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import GenericConnector from './generic';
import { OnchainPriority } from './scheduler';
import config from '../common/config';
import { sleep } from '../util';
import contractHelper from '../repositories/contracts';
import walletHelper from '../repositories/wallets';
import pool from '../util/postgres';
import ethereumApi from './ethereumApi';
import communityHelper from '../repositories/communities';

// this is a value between 0 and 1 which gives the probability
// to "double-check" a balance by retrieving it from chain again
const RECHECK_BALANCE_PROBABILITY = 1;
const activeChains = new Set(config.ACTIVE_CHAINS);

const connectors = config.ACTIVE_CHAINS.reduce((agg, chain) => {
  agg[chain] = new GenericConnector(chain);
  return agg;
}, {} as Partial<Record<Models.Contract.ChainIdentifier, Models.Server.OnchainConnector>>);

const apiCallsForRoleClaimChecks = {
  value: 0
};
export function howManyUsedAPICallsForRoleClaimChecks() {
  return apiCallsForRoleClaimChecks.value;
}

const claimableRoleJobs: Record<string, Record<string, Promise<boolean>>> = {};
export async function checkRoleClaimability(
  userId: string,
  roleId: string,
  assignmentRules: Models.Community.AssignmentRules & { type: "token" },
  priority: OnchainPriority = OnchainPriority.MEDIUM,
  timeout?: number | 'never',
) {
  let p = claimableRoleJobs[userId]?.[roleId];
  if (!p) {
    p = _checkRoleClaimability(userId, [{ id: roleId, assignmentRules }], priority, timeout).then(result => {
      return result.find(d => d.roleId === roleId)?.claimable || false;
    });
    if (!claimableRoleJobs[userId]) {
      claimableRoleJobs[userId] = {};
    }
    claimableRoleJobs[userId][roleId] = p;
  }
  let isAllowed = false;
  try {
    isAllowed = await p;
  } catch (e) {
    console.error("An error occurred in checkRoleClaimability: ", e);
  } finally {
    delete claimableRoleJobs[userId][roleId];
    if (Object.keys(claimableRoleJobs[userId]).length === 0) {
      delete claimableRoleJobs[userId];
    }
  }
  return isAllowed;
}

export async function checkMultiRoleClaimability(
  userId: string,
  roleData: {
    id: string,
    assignmentRules: Models.Community.AssignmentRules & { type: "token" },
  }[],
  priority: OnchainPriority = OnchainPriority.MEDIUM,
  timeout?: number | 'never',
) {
  try {
    return await _checkRoleClaimability(userId, roleData, priority, timeout);

  } catch (e) {
    console.error("An error occurred in checkMultiRoleClaimability: ", e);
  }
  return [];
}

const communityJobs:
  Map<string,
    Map<string,
      Promise<{ roleId: string, claimable: boolean }[]>
    >
  > = new Map();
export async function checkCommunityRoleClaimability(
  userId: string,
  communityId: string,
  priority: OnchainPriority,
  timeout?: number | 'never',
) {
  let communityJobMap = communityJobs.get(communityId);
  if (!communityJobMap) {
    communityJobMap = new Map();
    communityJobs.set(communityId, communityJobMap);
  }
  let job = communityJobMap.get(userId);
  if (!job) {
    const [
      communityRoles,
      existingRoles
    ] = await Promise.all([
      communityHelper.getCommunityRoles(communityId),
      communityHelper.getUserRoleRelationships({ communityId, userId })
    ]);
    const existingRolesMap = new Map(existingRoles.map(d => [d.roleId, d]));
    const tokenRoles = communityRoles.filter(r => r.assignmentRules?.type === "token") as (typeof communityRoles[0] & { assignmentRules: Models.Community.AssignmentRules & { type: "token" }})[];
    const tokenRolesToEvaluate = tokenRoles.filter(r => !(existingRolesMap.get(r.id)?.claimed));

    job = _checkRoleClaimability(userId, tokenRolesToEvaluate, priority, timeout)
      .finally(() => {
        communityJobMap?.delete(userId);
      });
    communityJobMap.set(userId, job);
  }
  return job;
}

// Todo: Cancel balance retrieval loop on request timeout?
// If the request times out, the API might be overloaded, so
// it would make sense to cancel jobs that are not awaited anymore
async function _checkRoleClaimability(
  userId: string,
  tokenRoles: {
    id: string;
    assignmentRules: Models.Community.AssignmentRules & { type: "token" };
  }[],
  priority: OnchainPriority,
  timeout?: number | 'never',
): Promise<{
  roleId: string;
  claimable: boolean;
}[]> {
  // get contract and wallet data
  const contractIds = tokenRoles.reduce<Set<string>>((agg, value) => {
    const rules = (value.assignmentRules as Models.Community.AssignmentRules & { type: "token" }).rules;
    agg.add(rules.rule1.contractId);
    if ("rule2" in rules) {
      agg.add(rules.rule2.contractId)
    }
    return agg;
  }, new Set());
  const [
    contractDataFromDB,
    wallets,
  ] = await Promise.all([
    contractHelper.getContractDataByIds(Array.from(contractIds)),
    walletHelper.getAllWalletsByUserId(userId, ["evm","contract_evm"]),
  ]);
  const contractDataById = new Map<string, Models.Contract.Data>();
  for (const contractData of contractDataFromDB) {
    contractDataById.set(contractData.id, contractData);
  }

  // get existing balances from database
  const balancesFromDb = await walletHelper.getWalletBalances(
    Array.from(contractDataById.keys()),
    wallets.map(w => w.id),
  );
  const _balanceStore = new Map<string, typeof balancesFromDb[0]>();
  for (const balanceFromDb of balancesFromDb) {
    _balanceStore.set(`${balanceFromDb.walletId}${balanceFromDb.contractId}`, balanceFromDb);
  }
  const getBalanceFromDb: (walletId: string, contractId: string) => (typeof balancesFromDb[0]) | undefined = (walletId, contractId) => {
    return _balanceStore.get(`${walletId}${contractId}`);
  }
  const pendingUpdates: Models.Contract.WalletBalance[] = [];

  // evaluate rules
  type BalanceData = {
    rule: Models.Community.GatingRule;
    balance: `${number}`;
  };
  const balancePromises: Promise<BalanceData>[] = [];
  const balancePromiseMap = new Map<string, Promise<{
    result: `${number}`;
    blockNumber: number;
  }>>();

  for (const role of tokenRoles) {
    const assignmentRules = role.assignmentRules as Models.Community.AssignmentRules & { type: "token" };
    const { rules } = assignmentRules;
    const rulesToEvaluate: Models.Community.GatingRule[] = [rules.rule1];
    if ("rule2" in rules) {
      rulesToEvaluate.push(rules.rule2);
    }
    for (const rule of rulesToEvaluate) {
      for (const wallet of wallets) {
        const contractData = contractDataById.get(rule.contractId);
        if (!!contractData) {
          // only get balance from chain if either recheck was
          // randomly triggered, or no balance exists in db
          const balanceFromDb = getBalanceFromDb(wallet.id, contractData.id);
          const isRandomCheck = Math.random() > (1 - RECHECK_BALANCE_PROBABILITY);
          const erc1155TokenBalance = (
            balanceFromDb?.balance.type === "ERC1155" && 
            rule.type === "ERC1155" &&
            balanceFromDb.balance.data.find(d => d.tokenId === rule.tokenId)
          );

          balancePromises.push((async () => {
            let balance: `${number}` = '0';
            if (!activeChains.has(contractData.chain) || (wallet.type === 'contract_evm' && contractData.chain !== wallet.chain)) {
              return {
                rule,
                balance,
              };
            }
            else if (contractData.data.type === 'ERC20' && rule.type === 'ERC20') {
              if (!balanceFromDb || isRandomCheck) {
                const key = `ERC20;${contractData.chain};${contractData.address};${wallet.walletIdentifier}`;
                let p = balancePromiseMap.get(key);
                if (!p) {
                  apiCallsForRoleClaimChecks.value += 2;
                  p = ethereumApi.requestData('ERC_20_contract.balanceOf', {
                    chain: contractData.chain,
                    contractAddress: contractData.address,
                    priority,
                    walletAddress: wallet.walletIdentifier,
                    timeout,
                    retry: true,
                  });
                  balancePromiseMap.set(key, p);
                }
                const { result, blockNumber } = await p;
                addUpdateIfNecessary(balancesFromDb, pendingUpdates, {
                  rule,
                  wallet,
                  contractData,
                  result,
                  blockNumber,
                });
                balance = result;
              } else {
                if (balanceFromDb.balance.type === 'ERC20') {
                  balance = balanceFromDb.balance.amount;
                } else {
                  console.error("Error: Contract and balance data don't match, expected ERC20", JSON.stringify({ balanceFromDb, contractData, rule }));
                }
              }

            }
            else if (contractData.data.type === 'ERC721' && rule.type === 'ERC721') {
              if (!balanceFromDb || isRandomCheck) {
                const key = `ERC721;${contractData.chain};${contractData.address};${wallet.walletIdentifier}`;
                let p = balancePromiseMap.get(key);
                if (!p) {
                  apiCallsForRoleClaimChecks.value += 2;
                  p = ethereumApi.requestData('ERC_721_contract.balanceOf', {
                    chain: contractData.chain,
                    contractAddress: contractData.address,
                    priority,
                    walletAddress: wallet.walletIdentifier,
                    timeout,
                    retry: true,
                  });
                  balancePromiseMap.set(key, p);
                }
                const { result, blockNumber } = await p;
                addUpdateIfNecessary(balancesFromDb, pendingUpdates, {
                  rule,
                  wallet,
                  contractData,
                  result,
                  blockNumber,
                });
                balance = result;
              } else {
                if (balanceFromDb.balance.type === 'ERC721') {
                  balance = balanceFromDb.balance.amount;
                } else {
                  console.error("Error: Contract and balance data don't match, expected ERC721", JSON.stringify({ balanceFromDb, contractData, rule }));
                }
              }

            }
            else if (contractData.data.type === 'ERC1155' && rule.type === 'ERC1155') {
              if (!balanceFromDb || isRandomCheck || !erc1155TokenBalance) {
                const key = `ERC1155;${contractData.chain};${contractData.address};${wallet.walletIdentifier};${rule.tokenId}`;
                let p = balancePromiseMap.get(key);
                if (!p) {
                  apiCallsForRoleClaimChecks.value += 2;
                  p = ethereumApi.requestData('ERC_1155_contract.balanceOf', {
                    chain: contractData.chain,
                    contractAddress: contractData.address,
                    priority,
                    walletAddress: wallet.walletIdentifier,
                    tokenId: rule.tokenId,
                    timeout,
                    retry: true,
                  });
                  balancePromiseMap.set(key, p);
                }
                const { result, blockNumber } = await p;
                addUpdateIfNecessary(balancesFromDb, pendingUpdates, {
                  rule,
                  wallet,
                  contractData,
                  result,
                  blockNumber,
                });
                balance = result;
              } else {
                if (balanceFromDb.balance.type === 'ERC1155') {
                  balance = erc1155TokenBalance.amount;
                } else {
                  console.error("Error: Contract and balance data don't match, expected ERC1155", JSON.stringify({ balanceFromDb, contractData, rule }));
                }
              }
            }
            else if (contractData.data.type === 'LSP7' && rule.type === 'LSP7') {
              if (!balanceFromDb || isRandomCheck) {
                const key = `LSP7;${contractData.chain};${contractData.address};${wallet.walletIdentifier}`;
                let p = balancePromiseMap.get(key);
                if (!p) {
                  apiCallsForRoleClaimChecks.value += 2;
                  p = ethereumApi.requestData('LSP_7_contract.balanceOf', {
                    chain: contractData.chain,
                    contractAddress: contractData.address,
                    priority,
                    walletAddress: wallet.walletIdentifier,
                    timeout,
                    retry: true,
                  });
                  balancePromiseMap.set(key, p);
                }
                const { result, blockNumber } = await p;
                addUpdateIfNecessary(balancesFromDb, pendingUpdates, {
                  rule,
                  wallet,
                  contractData,
                  result,
                  blockNumber,
                });
                balance = result;
              } else {
                if (balanceFromDb.balance.type === 'LSP7') {
                  balance = balanceFromDb.balance.amount;
                } else {
                  console.error("Error: Contract and balance data don't match, expected LSP7", JSON.stringify({ balanceFromDb, contractData, rule }));
                }
              }

            }
            else if (contractData.data.type === 'LSP8' && rule.type === 'LSP8') {
              if (!balanceFromDb || isRandomCheck) {
                const key = `LSP8;${contractData.chain};${contractData.address};${wallet.walletIdentifier}`;
                let p = balancePromiseMap.get(key);
                if (!p) {
                  apiCallsForRoleClaimChecks.value += 2;
                  p = ethereumApi.requestData('LSP_8_contract.balanceOf', {
                    chain: contractData.chain,
                    contractAddress: contractData.address,
                    priority,
                    walletAddress: wallet.walletIdentifier,
                    timeout,
                    retry: true,
                  });
                  balancePromiseMap.set(key, p);
                }
                const { result, blockNumber } = await p;
                addUpdateIfNecessary(balancesFromDb, pendingUpdates, {
                  rule,
                  wallet,
                  contractData,
                  result,
                  blockNumber,
                });
                balance = result;
              } else {
                if (balanceFromDb.balance.type === 'LSP8') {
                  balance = balanceFromDb.balance.amount;
                } else {
                  console.error("Error: Contract and balance data don't match, expected LSP8", JSON.stringify({ balanceFromDb, contractData, rule }));
                }
              }
            }
            return {
              rule,
              balance,
            };
          })());
        }
      }
    }
  }
  const balances = await Promise.all(balancePromises);

  const result: {
    roleId: string;
    claimable: boolean;
  }[] = [];
  for (const role of tokenRoles) {
    const assignmentRules = role.assignmentRules as Models.Community.AssignmentRules & { type: "token" };
    const { rules } = assignmentRules;
    const rulesToEvaluate: Models.Community.GatingRule[] = [rules.rule1];
    if ("rule2" in rules) {
      rulesToEvaluate.push(rules.rule2);
    }
    const claimable = new Array(rulesToEvaluate.length).fill(false);
    for (let i = 0; i < rulesToEvaluate.length; i++) {
      const rule = rulesToEvaluate[i];

      // chainBalances can contain duplicates with dbBalances because of
      // the random chance to do a double check, but we don't want to count
      // such balances twice. Instead, we're going to filter them and log
      // the compare result
      const chainBalances = balances.filter(b => b.rule === rule);
      let chainBalanceSum = 0n;
      
      // evaluate balances from chain
      for (const balance of chainBalances) {
        chainBalanceSum += BigInt(balance.balance);
      }
      
      // evaluate rule
      if (chainBalanceSum >= BigInt(rule.amount)) {
        claimable[i] = true;
      }
    }
    let isAllowed: boolean;
    if ("logic" in rules && rules.logic === "or") {
      isAllowed = claimable.some(v => !!v);
    } else {
      isAllowed = claimable.every(v => !!v);
    }
    result.push({
      roleId: role.id,
      claimable: isAllowed,
    });
  }
  if (pendingUpdates.length > 0) {
    await walletHelper.upsertWalletBalances(pendingUpdates);
  }
  const claimableRoles = result.filter(data => data.claimable === true);
  if (claimableRoles.length > 0) {
    const unclaimedRolesUpdated = await communityHelper.giveUserUnclaimedRoles(
      userId,
      claimableRoles.map(data => data.roleId),
    );
  }
  const unclaimableRoles = result.filter(data => data.claimable === false);
  if (unclaimableRoles.length > 0) {
    const removedRolesCount = await communityHelper.removeUserFromUnclaimableRoles(
      userId,
      unclaimableRoles.map(data => data.roleId),
    );
  }
  return result;
}

export async function getContractData(chain: Models.Contract.ChainIdentifier, contractAddress: Common.Address, skipWatch: boolean = false): Promise<Omit<Models.Contract.Data, 'id'>> {
  const connector = connectors[chain];
  if (!connector) {
    throw new Error(`Connector for chain ${chain} not found`);
  }
  const contractData = await connector.contractData(contractAddress, OnchainPriority.HIGH);
  if (contractData) {
    if (!skipWatch) {
      watchContract(contractData);
    }
    return contractData;
  } else {
    throw new Error("contractData returned falsy but did not throw");
  }
}

function watchContract(contract: Omit<Models.Contract.Data, "id"> & Partial<Pick<Models.Contract.Data, "id">>) {
  const connector = connectors[contract.chain];
  if (!connector) {
    return;
  }
  if (config.CONTINUOUS_ONCHAIN_CHECK === true || (contract.chain as any) === "hardhat" || (contract.chain as any) === "sokol") {
    connector.watchContract(contract);
  }
}

function safeAddBalanceUpdate(
  pendingUpdates: Models.Contract.WalletBalance[],
  update: Models.Contract.WalletBalance,
) {
  const existingUpdate = pendingUpdates.find(item =>
    item.contractId === update.contractId &&
    item.walletId === update.walletId
  );
  if (!!existingUpdate) {
    if (JSON.stringify(existingUpdate.balance) !== JSON.stringify(update.balance)) {
      console.warn(`Conflicting wallet balances for wallet ${existingUpdate.walletId}, contract ${existingUpdate.contractId} (using new)`, {
        old: existingUpdate.balance,
        new: update.balance,
      });
      existingUpdate.balance = update.balance;
    }
  } else {
    pendingUpdates.push(update);
  }
}

function addUpdateIfNecessary(
  fromDatabase: Models.Contract.WalletBalance[],
  pendingUpdates: Models.Contract.WalletBalance[],
  data: {
    rule: Models.Community.GatingRule;
    wallet: Models.Wallet.Wallet;
    contractData: Models.Contract.Data;
    result: `${number}`;
    blockNumber: number;
  },
) {
  const { rule, wallet, result, blockNumber: blockHeight } = data;
  // compare with db data and upsert if necessary
  const existingDb = fromDatabase.find(b =>
    b.contractId === rule.contractId &&
    b.walletId === wallet.id
  );
  if (!!existingDb) {
    if (rule.type === "ERC20") {
      if (existingDb.balance.type !== "ERC20") {
        const m = `Mismatch between rule type (ERC20) and database balance type (${existingDb.balance.type}) (walletId ${wallet.id}, contractId ${rule.contractId})`;
        throw new Error(m);
      }
      if (BigInt(existingDb.balance.amount) === BigInt(result)) {
        // console.log(`ERC20 chain balance matches database balance, that's good :) (walletId ${wallet.id}, contractId ${rule.contractId})`);
      } else {
        console.warn(`WARNING: ERC20 chain balance (${result}) does not match database balance, updating... (${existingDb.balance.amount}) (walletId ${wallet.id}, contractId ${rule.contractId})`);
        safeAddBalanceUpdate(pendingUpdates, {
          walletId: wallet.id,
          contractId: rule.contractId,
          balance: {
            type: "ERC20",
            blockHeight,
            amount: result,
          },
        });
      }
    }
    else if (rule.type === "ERC721") {
      if (existingDb.balance.type !== "ERC721") {
        const m = `Mismatch between rule type (ERC721) and database balance type (${existingDb.balance.type}) (walletId ${wallet.id}, contractId ${rule.contractId})`;
        throw new Error(m);
      }
      if (BigInt(existingDb.balance.amount) === BigInt(result)) {
        // console.log(`ERC721 chain balance matches database balance, that's good :) (walletId ${wallet.id}, contractId ${rule.contractId})`);
      } else {
        console.warn(`WARNING: ERC721 chain balance (${result}) does not match database balance, updating... (${existingDb.balance.amount}) (walletId ${wallet.id}, contractId ${rule.contractId})`);
        safeAddBalanceUpdate(pendingUpdates, {
          walletId: wallet.id,
          contractId: rule.contractId,
          balance: {
            type: "ERC721",
            blockHeight,
            amount: result,
          },
        });
      }
    }
    else if (rule.type === "ERC1155") {
      // Todo: this could create race conditions for heavily
      // used ERC1155 contracts, but the risk seems low, at
      // least for now - make update query very smartly update
      // the array content in the future
      if (existingDb.balance.type !== "ERC1155") {
        const m = `Mismatch between rule type (ERC1155) and database balance type (${existingDb.balance.type}) (walletId ${wallet.id}, contractId ${rule.contractId})`;
        throw new Error(m);
      }
      const balanceIdx = existingDb.balance.data.findIndex(b => b.tokenId === rule.tokenId);
      if (balanceIdx > -1) {
        // a balance for this tokenId exists
        const existingTokenBalance = existingDb.balance.data[balanceIdx]
        if (BigInt(existingTokenBalance.amount) === BigInt(result)) {
          // console.log(`ERC1155 chain balance matches database balance, that's good :) (walletId ${wallet.id}, contractId ${rule.contractId}, tokenId ${rule.tokenId})`);
        } else {
          console.warn(`WARNING: ERC1155 chain balance (${result}) does not match database balance, updating... (${existingTokenBalance.amount}) (walletId ${wallet.id}, contractId ${rule.contractId}, tokenId ${rule.tokenId})`);
          const existingUpdateIdx = pendingUpdates.findIndex(u => u.walletId === wallet.id && u.contractId === rule.contractId);
          if (existingUpdateIdx > -1) {
            // the db item is already scheduled for update
            const item = pendingUpdates[existingUpdateIdx];
            if (item.balance.type !== "ERC1155") {
              throw new Error(`Error in creating balance updates - conflicting update (walletId ${wallet.id}, contractId ${rule.contractId}, tokenId ${rule.tokenId})`);
            }
            const tokenBalanceIdx = item.balance.data.findIndex(d => d.tokenId === rule.tokenId);
            if (tokenBalanceIdx > -1) {
              // this token already has a balance in the update item
              if (item.balance.data[tokenBalanceIdx].amount !== result) {
                console.warn(`Unexpected balance change from ${item.balance.data[tokenBalanceIdx].amount} to ${result} (walletId ${wallet.id}, contractId ${rule.contractId}, tokenId ${rule.tokenId})`);
              }
              item.balance.data[tokenBalanceIdx].amount = result;
              item.balance.data[tokenBalanceIdx].blockHeight = blockHeight;
            } else {
              item.balance.data.push({
                amount: result,
                blockHeight,
                tokenId: rule.tokenId,
              });
            }
          } else {
            // there is no update scheduled for this db item yet
            safeAddBalanceUpdate(pendingUpdates, {
              walletId: wallet.id,
              contractId: rule.contractId,
              balance: {
                type: "ERC1155",
                data: [
                  ...existingDb.balance.data,
                  {
                    blockHeight,
                    amount: result,
                    tokenId: rule.tokenId,
                  }
                ],
              },
            });
          }
        }
      } else {
        safeAddBalanceUpdate(pendingUpdates, {
          walletId: wallet.id,
          contractId: rule.contractId,
          balance: {
            type: "ERC1155",
            data: [
              ...existingDb.balance.data,
              {
                blockHeight,
                amount: result,
                tokenId: rule.tokenId,
              }
            ],
          },
        });
      }
    }
    else if (rule.type === 'LSP7') {
      if (existingDb.balance.type !== "LSP7") {
        const m = `Mismatch between rule type (LSP7) and database balance type (${existingDb.balance.type}) (walletId ${wallet.id}, contractId ${rule.contractId})`;
        throw new Error(m);
      }
      if (BigInt(existingDb.balance.amount) === BigInt(result)) {
        // console.log(`LSP7 chain balance matches database balance, that's good :) (walletId ${wallet.id}, contractId ${rule.contractId})`);
      } else {
        console.warn(`WARNING: LSP7 chain balance (${result}) does not match database balance, updating... (${existingDb.balance.amount}) (walletId ${wallet.id}, contractId ${rule.contractId})`);
        safeAddBalanceUpdate(pendingUpdates, {
          walletId: wallet.id,
          contractId: rule.contractId,
          balance: {
            type: "LSP7",
            blockHeight,
            amount: result,
          },
        });
      }
    }
    else if (rule.type === 'LSP8') {
      if (existingDb.balance.type !== "LSP8") {
        const m = `Mismatch between rule type (LSP8) and database balance type (${existingDb.balance.type}) (walletId ${wallet.id}, contractId ${rule.contractId})`;
        throw new Error(m);
      }
      if (BigInt(existingDb.balance.amount) === BigInt(result)) {
        // console.log(`LSP8 chain balance matches database balance, that's good :) (walletId ${wallet.id}, contractId ${rule.contractId})`);
      } else {
        console.warn(`WARNING: LSP8 chain balance (${result}) does not match database balance, updating... (${existingDb.balance.amount}) (walletId ${wallet.id}, contractId ${rule.contractId})`);
        safeAddBalanceUpdate(pendingUpdates, {
          walletId: wallet.id,
          contractId: rule.contractId,
          balance: {
            type: "LSP8",
            blockHeight,
            amount: result,
          },
        });
      }
    }
  } else {
    if (rule.type === "ERC20") {
      safeAddBalanceUpdate(pendingUpdates, {
        walletId: wallet.id,
        contractId: rule.contractId,
        balance: {
          type: "ERC20",
          blockHeight,
          amount: result,
        },
      });
    }
    else if (rule.type === "ERC721") {
      safeAddBalanceUpdate(pendingUpdates, {
        walletId: wallet.id,
        contractId: rule.contractId,
        balance: {
          type: "ERC721",
          blockHeight,
          amount: result,
        },
      });
    }
    else if (rule.type === "ERC1155") {
      safeAddBalanceUpdate(pendingUpdates, {
        walletId: wallet.id,
        contractId: rule.contractId,
        balance: {
          type: "ERC1155",
          data: [{
            blockHeight,
            tokenId: rule.tokenId,
            amount: result,
          }],
        },
      });
    }
    else if (rule.type === 'LSP7') {
      safeAddBalanceUpdate(pendingUpdates, {
        walletId: wallet.id,
        contractId: rule.contractId,
        balance: {
          type: "LSP7",
          blockHeight,
          amount: result,
        },
      });
    }
    else if (rule.type === 'LSP8') {
      safeAddBalanceUpdate(pendingUpdates, {
        walletId: wallet.id,
        contractId: rule.contractId,
        balance: {
          type: "LSP8",
          blockHeight,
          amount: result,
        },
      });
    }
  }
}

export async function getSingleTransactionData(
  chain: Models.Contract.ChainIdentifier,
  txHash: string,
): Promise<{
  found: boolean;
  initiatorAddress?: Common.Address;
  transfers: {
    type: 'erc20' | 'native';
    contractAddress?: Common.Address;
    from: Common.Address;
    to: Common.Address;
    amount: string;
  }[];
}> {
  return ethereumApi.requestData('getSingleTransactionData', { chain, txHash, priority: OnchainPriority.HIGH, retry: true });
}

export async function getErc20Balance(
  chain: Models.Contract.ChainIdentifier,
  contractAddress: Common.Address,
  walletAddress: Common.Address,
  priority: OnchainPriority,
): Promise<`${number}`> {
  const { result } = await ethereumApi.requestData('ERC_20_contract.balanceOf', { chain, contractAddress, walletAddress, priority, retry: true });
  return result;
}

export async function getBlockNumber(
  chain: Models.Contract.ChainIdentifier,
): Promise<number> {
  const { blockNumber } = await ethereumApi.requestData('getBlockNumber', { chain, priority: OnchainPriority.HIGH, retry: true });
  return blockNumber;
}

(async () => {
  const client = await pool.connect();
  client.query('LISTEN contractchange');
  client.query('LISTEN walletchange');

  // Keepalive
  let interval: any = undefined;
  interval = setInterval(async () => {
    try {
      await client.query('SELECT 1');
    }
    catch (e) {
      console.log("KEEPALIVE ERROR", e);
      clearInterval(interval);
      process.exit(1);
    }
  }, 60000);

  client.on("notification", (msg) => {
    if (!!msg.payload) {
      try {
        const payload = JSON.parse(msg.payload) as Events.PgNotify.ContractChange | Events.PgNotify.WalletChange;
        if (payload?.type === "contractchange") {
          // Todo: Anything? Contract should be watched on add
          // automatically.
          return;
        }
        else if (payload?.type === "walletchange") {
          if (payload.deletedAt === payload.updatedAt) {
            // Wallet deleted
            // Todo: Anything?
          }
          if (payload.walletType === 'contract_evm' && !!payload.chain) {
            if (!payload.signatureData.contractData) {
              console.error("Missing contractData in signatureData", payload);
            }
            else if (payload.deletedAt === payload.updatedAt) {
              // Wallet deleted
              // Todo: Anything?
            }
            else if (payload.signatureData.contractData.type === "universal_profile") {
              // Wallet created
              connectors[payload.chain]?.watchSpecialContract(payload.signatureData.contractData, payload.walletIdentifier as Common.Address);
            }
          }
          return;
        }
      } catch (e) {}
    }
    console.log('Unknown postgres notification', msg);
  });
})();

(async () => {
  const contracts = await contractHelper.getAll();
  for (const contract of contracts) {
    watchContract(contract);
  }

  await sleep(5000);
  const chains = Object.keys(connectors) as Models.Contract.ChainIdentifier[];
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i];
    if (config.CONTINUOUS_ONCHAIN_CHECK === true || (chain as any) === "hardhat") {
      console.log("Starting event listener loop for chain", chain);
      connectors[chain]!.startEventListener();
      await sleep(5000);
    }
  }
})();