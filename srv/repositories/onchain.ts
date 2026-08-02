// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import axios from "../util/axios";
import pool from "../util/postgres";
import { OnchainPriority } from "../onchain/scheduler";

class OnchainHelper {
  async #request(
    path: `/${string}`,
    data: any,
  ) {
    // Using axios
    const url = `http://onchain:4000${path}`;
    const response = await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return response.data;
  }

  public async getContractData(
    chain: Models.Contract.ChainIdentifier,
    address: Common.Address,
    skipWatch: boolean = false,
  ): Promise<Omit<Models.Contract.Data, "id">> {
    const result = await this.#request('/getContractData', { chain, address, skipWatch });
    console.log("Retrieved contract data: ", result);
    return result;
  }
  
  public async checkRoleClaimability(data: {
    userId: string,
    roleId: string;
    assignmentRules: Models.Community.AssignmentRules & { type: "token" };
    priority: OnchainPriority;
  }): Promise<boolean> {
    const result = await this.#request('/checkRoleClaimability', data);
    console.log(result);
    return result.data;
  }

  public async checkMultiRoleClaimability(data: {
    userId: string,
    roleData: {
      id: string;
      assignmentRules: Models.Community.AssignmentRules & { type: "token" };
    }[];
    priority: OnchainPriority;
  }): Promise<{
    roleId: string;
    claimable: boolean;
  }[]> {
    const result = await this.#request('/checkMultiRoleClaimability', data);
    console.log(result);
    return result.data;
  }

  public async checkCommunityRoleClaimability(data: {
    userId: string,
    communityId: string,
  }): Promise<{
    roleId: string;
    claimable: boolean;
  }[]> {
    const result = await this.#request('/checkCommunityRoleClaimability', data);
    console.log(result);
    return result.data;
  }

  public async getChainData(
    chain: Models.Contract.ChainIdentifier,
  ): Promise<{
    lastBlock: number;
  } | undefined> {
    const query = `
      SELECT data
      FROM chaindata
      WHERE id = $1
    `;
    const result = await pool.query(query, [chain]);
    if (result.rows.length === 1) {
      return result.rows[0].data;
    }
  }

  public async setChainData(
    chain: Models.Contract.ChainIdentifier,
    data: {
      lastBlock: number;
    },
  ): Promise<void> {
    const query = `
      INSERT INTO chaindata (id, data)
      VALUES ($1, $2::json)
      ON CONFLICT (id)
        DO UPDATE SET data = EXCLUDED.data
    `;
    const result = await pool.query(query, [
      chain,
      JSON.stringify(data),
    ]);
    if (result.rowCount !== 1) {
      console.error(`Could not save chaindata for ${chain}`);
    }
  }

  public async luksoIsValidSignature(
      address: string,
      signature: string,
      message: string
  ): Promise<boolean> {
    const result = await this.#request('/luksoIsValidSignature', {address, signature, message});
    return result;
  }

  public async luksoGetUniversalProfileData(
      address: string
  ): Promise<{
    username: string;
    profileImageUrl: string;
    description: string;
  }> {
    try {
      const result = await this.#request('/luksoGetUniversalProfileData', {address});
      return result;
    } catch (error) {
      console.error("Error in luksoGetUniversalProfileData: ", error);
      throw error;
    }
  }

  public async getSingleTransactionData(
    chain: Models.Contract.ChainIdentifier,
    txHash: string
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
    try {
      const result = await this.#request('/getSingleTransactionData', { chain, txHash });
      return result;
    } catch (error) {
      console.error("Error in getSingleTransactionData: ", error);
      throw error;
    }
  }

  public async getErc20Balance(
    chain: Models.Contract.ChainIdentifier,
    contractAddress: Common.Address,
    walletAddress: Common.Address,
  ): Promise<`${number}`> {
    const result: { balance: `${number}` } = await this.#request('/getErc20Balance', { chain, contractAddress, walletAddress });
    return result.balance;
  }

  public async getBlockNumber(
    chain: Models.Contract.ChainIdentifier,
  ): Promise<{ blockNumber: number }> {
    const result = await this.#request('/getBlockNumber', { chain });
    return result;
  }
}

const onchainHelper = new OnchainHelper();
export default onchainHelper;