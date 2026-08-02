// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/* eslint-disable no-useless-computed-key */
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { OnchainPriority } from './scheduler';
import config from '../common/config';
import settings from './settings';
import { randomString, sleep } from '../util';
import { BlockTag, ethers, Contract, FetchRequest } from 'ethers';
import {
  IERC165_abi,
  IERC20Metadata_abi,
  IERC721Metadata_abi,
  IERC1155MetadataURI_abi,
  IERC725Y_abi,
  LSP7_abi,
  LSP8_abi
} from "./abis";
import {
  EIP_1167_BEACON_ABI,
  EIP_897_ABI,
  GNOSIS_SAFE_PROXY_ABI
} from './detectProxy';

const BASE_COOLDOWN = 1000 / settings.MAX_REQUESTS_PER_SECOND;

type RPCCallType =
  'getBlockNumber' |
  'getBlockTransactions' |
  'getStorage' |
  'getCode' |
  'getLogs' |
  'getSingleTransactionData' |
  'EIP_897_contract.implementation' |
  'EIP_1167_beaconContract.implementation' |
  'EIP_1167_beaconContract.childImplementation' |
  'GNOSIS_SAFE_PROXY_contract.masterCopy' |
  'ERC_165_contract.supportsInterface' |
  'ERC_20_contract.name' |
  'ERC_20_contract.symbol' |
  'ERC_20_contract.decimals' |
  'ERC_20_contract.balanceOf' |
  'ERC_721_contract.name' |
  'ERC_721_contract.symbol' |
  'ERC_721_contract.balanceOf' |
  'ERC_1155_contract.balanceOf' |
  'ERC_725Y_contract.getData' |
  'ERC_725Y_contract.getDataBatch' |
  'LSP_7_contract.decimals' |
  'LSP_7_contract.balanceOf' | 
  'LSP_8_contract.balanceOf';

type Request<T extends RPCCallType> = {
  requestId: string;
  priority: OnchainPriority;
  type: T;
  retry: boolean;
  timeout?: number | 'never';
} & (
  // special cases
  T extends 'getBlockNumber' ?
    {
      chain: Models.Contract.ChainIdentifier;
    }
  : T extends 'getBlockTransactions' ?
    {
      chain: Models.Contract.ChainIdentifier;
      blockNumber: BlockTag;
    }
  : T extends 'getLogs' ?
    {
      chain: Models.Contract.ChainIdentifier;
      fromBlock: BlockTag;
      toBlock: BlockTag;
    }
  : T extends 'getSingleTransactionData' ?
    {
      chain: Models.Contract.ChainIdentifier;
      txHash: string;
    }

  // "normal" contract calls
  : {
    chain: Models.Contract.ChainIdentifier;
    contractAddress: Common.Address;
    blockTag?: BlockTag;
  } & (
    T extends 'getStorage' ?
      {
        position_bn: `${number}`;
      }
    : T extends
      'ERC_20_contract.balanceOf' |
      'ERC_721_contract.balanceOf' |
      'LSP_7_contract.balanceOf' | 
      'LSP_8_contract.balanceOf' ?
      {
        walletAddress: Common.Address;
      }
    : T extends 'ERC_1155_contract.balanceOf' ?
      {
        walletAddress: Common.Address;
        tokenId: `${number}`;
      }
    : T extends 'ERC_165_contract.supportsInterface' ?
      {
        interfaceHash: string;
      }
    : T extends 'ERC_725Y_contract.getData' ?
      {
        key: string;
      }
    : T extends 'ERC_725Y_contract.getDataBatch' ?
      {
        keys: string[];
      }
    : {}
  )
);

type Response<T extends RPCCallType> = {
  requestId: string;
} & (
  // special cases
  T extends 'getBlockNumber' ?
    {
      blockNumber: number;
    }
  : T extends 'getBlockTransactions' ?
    {
      transactions: {
        txHash: string;
        from: Common.Address;
        to: Common.Address | null;
        gasLimit: string;
        value: string;
      }[];
    }
  : T extends 'getLogs' ?
    {
      logs: ethers.Log[];
    }
  : T extends 'getSingleTransactionData' ?
    {
      found: boolean;
      initiatorAddress?: Common.Address;
      transfers: {
        type: 'erc20' | 'native';
        contractAddress?: Common.Address;
        from: Common.Address;
        to: Common.Address;
        amount: string;
      }[];
    }
  : T extends
    'ERC_20_contract.decimals' |
    'LSP_7_contract.decimals' ?
    {
      result: number;
    }
  : T extends
    'ERC_20_contract.balanceOf' |
    'ERC_721_contract.balanceOf' |
    'ERC_1155_contract.balanceOf' |
    'LSP_7_contract.balanceOf' | 
    'LSP_8_contract.balanceOf' ?
    {
      result: `${number}`;
      blockNumber: number;
    }
  : T extends 'ERC_165_contract.supportsInterface' ?
    {
      result: boolean;
    }
  : T extends
    'getStorage' |
    'getCode' |
    'EIP_897_contract.implementation' |
    'EIP_1167_beaconContract.implementation' |
    'EIP_1167_beaconContract.childImplementation' |
    'GNOSIS_SAFE_PROXY_contract.masterCopy' |
    'ERC_20_contract.name' |
    'ERC_20_contract.symbol' |
    'ERC_721_contract.name' |
    'ERC_721_contract.symbol' ?
    {
      result: string;
    }
  : T extends 'ERC_725Y_contract.getData' ?
    {
      value: any;
    }
  : T extends 'ERC_725Y_contract.getDataBatch' ?
    {
      values: any[];
    }
  : never
);
class EthereumApi {
  private workers: Worker[] = [];
  private workerInfo: {
    scheduled: number;
    finished: number;
    retries: number;
  }[] = [];
  private roundRobinCounter = 0;
  private promises: Map<string, {
    promise: Promise<Response<RPCCallType>>;
    resolve: (response: Response<RPCCallType>) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private ready: Promise<void>;
  private readyCounter = 0;
  private markAsReady?: () => void;
  private neverEndingRequests = new Set<string>();

  constructor() {
    for (let i = 0; i < settings.NUM_BACKEND_WORKERS; i++) {
      const workerId = i;
      const worker = new Worker(__filename, { workerData: { workerId }});
      worker.on('message', this.onMessage.bind(this, workerId));
      worker.on('error', this.onError.bind(this));
      worker.on('exit', this.onExit.bind(this));
      this.workers.push(worker);
      this.workerInfo[workerId] = {
        scheduled: 0,
        finished: 0,
        retries: 0,
      };
    }
    this.ready = new Promise((resolve) => {
      this.markAsReady = resolve;
    });
    setInterval(() => {
      console.log(`Onchain API: ${this.neverEndingRequests.size} queued requests with timeout=never`);
      this.workerInfo.forEach((info, i) => {
        console.log(`Worker ${i} | ${info.finished}/${info.scheduled} (finished/scheduled) | ${info.retries} (retries)`);
      });
    }, 30000);
  }

  private onMessage(
    workerId: number,
    msg:
      (Response<RPCCallType> & { type: 'success' }) |
      { type: 'error', message: string, requestId: string } |
      { type: 'info', scheduled: number, finished: number, retries: number } |
      'READY') {
    if (msg === 'READY') {
      console.log(`WORKER ${workerId} IS READY!`);
      this.readyCounter++;
      if (this.readyCounter === settings.NUM_BACKEND_WORKERS) {
        this.markAsReady?.();
        console.log(`ALL WORKERS READY!`);
      }

    } else if (msg.type === 'info') {
      this.workerInfo[workerId] = msg;

    } else {
      const promiseData = this.promises.get(msg.requestId);
      if (!!promiseData) {
        if (msg.type === 'success') {
          const { type, ...response } = msg;
          promiseData.resolve(response);
        } else {
          promiseData.reject(new Error(msg.message));
        }
      } else {
        console.error(`Received unexpected message from worker, no promise data found for this ${msg.type} message (requestId ${msg.requestId})`);
      }
    }
  }

  private onError(err: Error & { requestId?: string }) {
    console.log("ERROR IN WORKER", err);
  }

  private onExit(code: number) {
    console.log("WORKER EXIT", code);
  }

  private async postMessage(msg: Request<any>) {
    await this.ready;
    this.roundRobinCounter = (this.roundRobinCounter + 1) % settings.NUM_BACKEND_WORKERS;
    this.workers[this.roundRobinCounter].postMessage(msg);
  }

  public requestData<T extends RPCCallType>(type: T, request: Omit<Request<T>, 'requestId' | 'type'>): Promise<Omit<Response<T>, 'requestId'>> {
    const requestId = randomString(20);

    const obj: {
      promise?: Promise<Response<RPCCallType>>;
      resolve?: (response: Response<RPCCallType>) => void;
      reject?: (error: Error) => void;
    } = {};
    const promise = new Promise<Response<RPCCallType>>((resolve, reject) => {
      let timer: any;
      if (request.timeout === 'never') {
        this.neverEndingRequests.add(requestId);
      } else {
        timer = setTimeout(() => {
          this.promises.delete(requestId);
          reject(new Error("Requesting data timed out"));
        }, request.timeout === undefined ? settings.DEFAULT_REQUEST_TIMEOUT : request.timeout);
      }
      obj.resolve = (response: Response<RPCCallType>) => {
        !!timer && clearTimeout(timer);
        this.promises.delete(requestId);
        delete (response as any).requestId;
        this.neverEndingRequests.delete(requestId);
        resolve(response);
      }
      obj.reject = (err: any) => {
        !!timer && clearTimeout(timer);
        this.promises.delete(requestId);
        this.neverEndingRequests.delete(requestId);
        reject(err);
      }
      this.postMessage({
        ...request,
        type,
        requestId,
      } as any);
    });
    obj.promise = promise;
    this.promises.set(requestId, obj as any);

    return promise as any as Promise<Response<T>>;
  }
}

// BEGIN MAIN THREAD CODE

const o = { ethereumApi: undefined as EthereumApi | undefined };
if (isMainThread) {
  // We're in the main thread
  o.ethereumApi = new EthereumApi(); 
}
// END MAIN THREAD CODE


// BEGIN WORKER CODE
else {
  let providers: {
    [chain in Models.Contract.ChainIdentifier]: ethers.JsonRpcProvider;
  };
  {
    const eth_fetchRequest = new FetchRequest(settings['eth'].PROVIDER_URL);
    eth_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const eth_network = ethers.Network.from(settings['eth'].CHAIN_ID);
    const eth = new ethers.JsonRpcProvider(eth_fetchRequest, eth_network, { staticNetwork: eth_network });

    const bsc_fetchRequest = new FetchRequest(settings['bsc'].PROVIDER_URL);
    bsc_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const bsc_network = ethers.Network.from(settings['bsc'].CHAIN_ID);
    const bsc = new ethers.JsonRpcProvider(bsc_fetchRequest, bsc_network, { staticNetwork: bsc_network });

    const matic_fetchRequest = new FetchRequest(settings['matic'].PROVIDER_URL);
    matic_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const matic_network = ethers.Network.from(settings['matic'].CHAIN_ID);
    const matic = new ethers.JsonRpcProvider(matic_fetchRequest, matic_network, { staticNetwork: matic_network });

    const xdai_fetchRequest = new FetchRequest(settings['xdai'].PROVIDER_URL);
    xdai_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const xdai_network = ethers.Network.from(settings['xdai'].CHAIN_ID);
    const xdai = new ethers.JsonRpcProvider(xdai_fetchRequest, xdai_network, { staticNetwork: xdai_network });

    const fantom_fetchRequest = new FetchRequest(settings['fantom'].PROVIDER_URL);
    fantom_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const fantom_network = ethers.Network.from(settings['fantom'].CHAIN_ID);
    const fantom = new ethers.JsonRpcProvider(fantom_fetchRequest, fantom_network, { staticNetwork: fantom_network });

    const avax_fetchRequest = new FetchRequest(settings['avax'].PROVIDER_URL);
    avax_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const avax_network = ethers.Network.from(settings['avax'].CHAIN_ID);
    const avax = new ethers.JsonRpcProvider(avax_fetchRequest, avax_network, { staticNetwork: avax_network });

    const arbitrum_fetchRequest = new FetchRequest(settings['arbitrum'].PROVIDER_URL);
    arbitrum_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const arbitrum_network = ethers.Network.from(settings['arbitrum'].CHAIN_ID);
    const arbitrum = new ethers.JsonRpcProvider(arbitrum_fetchRequest, arbitrum_network, { staticNetwork: arbitrum_network });

    const arbitrum_nova_fetchRequest = new FetchRequest(settings['arbitrum_nova'].PROVIDER_URL);
    arbitrum_nova_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const arbitrum_nova_network = ethers.Network.from(settings['arbitrum_nova'].CHAIN_ID);
    const arbitrum_nova = new ethers.JsonRpcProvider(arbitrum_nova_fetchRequest, arbitrum_nova_network, { staticNetwork: arbitrum_nova_network });

    const optimism_fetchRequest = new FetchRequest(settings['optimism'].PROVIDER_URL);
    optimism_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const optimism_network = ethers.Network.from(settings['optimism'].CHAIN_ID);
    const optimism = new ethers.JsonRpcProvider(optimism_fetchRequest, optimism_network, { staticNetwork: optimism_network });

    const base_fetchRequest = new FetchRequest(settings['base'].PROVIDER_URL);
    base_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const base_network = ethers.Network.from(settings['base'].CHAIN_ID);
    const base = new ethers.JsonRpcProvider(base_fetchRequest, base_network, { staticNetwork: base_network });

    const celo_fetchRequest = new FetchRequest(settings['celo'].PROVIDER_URL);
    celo_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const celo_network = ethers.Network.from(settings['celo'].CHAIN_ID);
    const celo = new ethers.JsonRpcProvider(celo_fetchRequest, celo_network, { staticNetwork: celo_network });

    const polygon_zkevm_fetchRequest = new FetchRequest(settings['polygon_zkevm'].PROVIDER_URL);
    polygon_zkevm_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const polygon_zkevm_network = ethers.Network.from(settings['polygon_zkevm'].CHAIN_ID);
    const polygon_zkevm = new ethers.JsonRpcProvider(polygon_zkevm_fetchRequest, polygon_zkevm_network, { staticNetwork: polygon_zkevm_network });

    const scroll_fetchRequest = new FetchRequest(settings['scroll'].PROVIDER_URL);
    scroll_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const scroll_network = ethers.Network.from(settings['scroll'].CHAIN_ID);
    const scroll = new ethers.JsonRpcProvider(scroll_fetchRequest, scroll_network, { staticNetwork: scroll_network });

    const zksync_fetchRequest = new FetchRequest(settings['zksync'].PROVIDER_URL);
    zksync_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const zksync_network = ethers.Network.from(settings['zksync'].CHAIN_ID);
    const zksync = new ethers.JsonRpcProvider(zksync_fetchRequest, zksync_network, { staticNetwork: zksync_network });

    const linea_fetchRequest = new FetchRequest(settings['linea'].PROVIDER_URL);
    linea_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const linea_network = ethers.Network.from(settings['linea'].CHAIN_ID);
    const linea = new ethers.JsonRpcProvider(linea_fetchRequest, linea_network, { staticNetwork: linea_network });

    const lukso_fetchRequest = new FetchRequest(settings['lukso'].PROVIDER_URL);
    lukso_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const lukso_network = ethers.Network.from(settings['lukso'].CHAIN_ID);
    const lukso = new ethers.JsonRpcProvider(lukso_fetchRequest, lukso_network, { staticNetwork: lukso_network });

    providers = {
      eth,
      bsc,
      matic,
      xdai,
      fantom,
      avax,
      arbitrum,
      optimism,
      base,
      linea,
      arbitrum_nova,
      celo,
      polygon_zkevm,
      scroll,
      zksync,
      lukso,
    };
  }

  // add hardhat for local development
  if (config.DEPLOYMENT === 'dev') {
    const hardhat_fetchRequest = new FetchRequest(settings['hardhat'].PROVIDER_URL);
    hardhat_fetchRequest.timeout = settings.DEFAULT_PROVIDER_TIMEOUT;
    const hardhat_network = ethers.Network.from(settings['hardhat'].CHAIN_ID);
    const hardhat = new ethers.JsonRpcProvider(hardhat_fetchRequest, hardhat_network, { staticNetwork: hardhat_network });
    (providers as any)['hardhat'] = hardhat;
  }
  if (config.DEPLOYMENT !== 'prod') {
    // Todo: set up on some test network, like ropsten
  }

  const handlers = {
    ['getBlockNumber']: {
      factor: 1,
      fn: async (request: Request<'getBlockNumber'>) => {
        const { requestId, chain } = request;
        const blockNumber = await providers[chain].getBlockNumber();
        const response: Response<'getBlockNumber'> = {
          requestId,
          blockNumber,
        };
        return response;
      }
    },
    ['getBlockTransactions']: {
      factor: 1,
      fn: async (request: Request<'getBlockTransactions'>) => {
        const { requestId, chain, blockNumber: blockTag } = request;
        const block = await providers[chain].getBlock(blockTag, true);
        const response: Response<'getBlockTransactions'> = {
          requestId,
          transactions: block?.prefetchedTransactions.map(t => ({
            txHash: t.hash,
            from: t.from.toLowerCase() as Common.Address,
            to: (t.to?.toLowerCase() as Common.Address | undefined) || null,
            gasLimit: t.gasLimit.toString(),
            value: t.value.toString(),
          })) || [],
        };
        return response;
      }
    },
    ['getStorage']: {
      factor: 1,
      fn: async (request: Request<'getStorage'>) => {
        const { requestId, contractAddress, chain, blockTag, position_bn } = request;
        const result = await providers[chain].getStorage(contractAddress, position_bn, blockTag);
        const response: Response<'getStorage'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['getCode']: {
      factor: 1,
      fn: async (request: Request<'getCode'>) => {
        const { requestId, contractAddress, chain, blockTag } = request;
        const result = await providers[chain].getCode(contractAddress, blockTag);
        const response: Response<'getCode'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['getLogs']: {
      factor: 1,
      fn: async (request: Request<'getLogs'>) => {
        const { requestId, chain, fromBlock, toBlock } = request;
        const logs = await providers[chain].getLogs({ fromBlock, toBlock });
        const response: Response<'getLogs'> = {
          requestId,
          logs,
        };
        return response;
      }
    },
    ['EIP_897_contract.implementation']: {
      factor: 1,
      fn: async (request: Request<'EIP_897_contract.implementation'>) => {
        const { requestId, contractAddress, chain, blockTag } = request;
        const contract = new Contract(contractAddress, EIP_897_ABI, providers[chain]);
        const result: string = await contract.implementation({ blockTag });
        const response: Response<'EIP_897_contract.implementation'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['EIP_1167_beaconContract.implementation']: {
      factor: 1,
      fn: async (request: Request<'EIP_1167_beaconContract.implementation'>) => {
        const { requestId, contractAddress, chain, blockTag } = request;
        const contract = new Contract(contractAddress, EIP_1167_BEACON_ABI, providers[chain]);
        const result: string = await contract.implementation({ blockTag });
        const response: Response<'EIP_1167_beaconContract.implementation'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['EIP_1167_beaconContract.childImplementation']: {
      factor: 1,
      fn: async (request: Request<'EIP_1167_beaconContract.childImplementation'>) => {
        const { requestId, contractAddress, chain, blockTag } = request;
        const contract = new Contract(contractAddress, EIP_1167_BEACON_ABI, providers[chain]);
        const result: string = await contract.childImplementation({ blockTag });
        const response: Response<'EIP_1167_beaconContract.childImplementation'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['GNOSIS_SAFE_PROXY_contract.masterCopy']: {
      factor: 1,
      fn: async (request: Request<'GNOSIS_SAFE_PROXY_contract.masterCopy'>) => {
        const { requestId, contractAddress, chain, blockTag } = request;
        const contract = new Contract(contractAddress, GNOSIS_SAFE_PROXY_ABI, providers[chain]);
        const result: string = await contract.masterCopy({ blockTag });
        const response: Response<'GNOSIS_SAFE_PROXY_contract.masterCopy'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['ERC_165_contract.supportsInterface']: {
      factor: 1,
      fn: async (request: Request<'ERC_165_contract.supportsInterface'>) => {
        const { requestId, contractAddress, chain, interfaceHash } = request;
        const contract = new Contract(contractAddress, IERC165_abi, providers[chain]);
        const result: boolean = await contract.getFunction('supportsInterface').staticCall(interfaceHash);
        const response: Response<'ERC_165_contract.supportsInterface'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['ERC_20_contract.name']: {
      factor: 1,
      fn: async (request: Request<'ERC_20_contract.name'>) => {
        const { requestId, contractAddress, chain } = request;
        const contract = new Contract(contractAddress, IERC20Metadata_abi, providers[chain]);
        const result: string = await contract.getFunction('name').staticCall();
        const response: Response<'ERC_20_contract.name'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['ERC_20_contract.symbol']: {
      factor: 1,
      fn: async (request: Request<'ERC_20_contract.symbol'>) => {
        const { requestId, contractAddress, chain } = request;
        const contract = new Contract(contractAddress, IERC20Metadata_abi, providers[chain]);
        const result: string = await contract.getFunction('symbol').staticCall();
        const response: Response<'ERC_20_contract.symbol'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['ERC_20_contract.decimals']: {
      factor: 1,
      fn: async (request: Request<'ERC_20_contract.decimals'>) => {
        const { requestId, contractAddress, chain } = request;
        const contract = new Contract(contractAddress, IERC20Metadata_abi, providers[chain]);
        const result: BigInt = await contract.getFunction('decimals').staticCall();
        const response: Response<'ERC_20_contract.decimals'> = {
          requestId,
          result: Number(result),
        };
        return response;
      }
    },
    ['ERC_20_contract.balanceOf']: {
      factor: 2,
      fn: async (request: Request<'ERC_20_contract.balanceOf'>) => {
        const { requestId, contractAddress, chain, walletAddress } = request;
        const contract = new Contract(contractAddress, IERC20Metadata_abi, providers[chain]);
        const [
          result,
          blockNumber,
        ] = await Promise.all([
          contract.getFunction('balanceOf').staticCall(walletAddress) as Promise<bigint>,
          providers[chain].getBlockNumber(),
        ]);
        const response: Response<'ERC_20_contract.balanceOf'> = {
          requestId,
          result: result.toString() as `${number}`,
          blockNumber,
        };
        return response;
      }
    },
    ['ERC_721_contract.name']: {
      factor: 1,
      fn: async (request: Request<'ERC_721_contract.name'>) => {
        const { requestId, contractAddress, chain } = request;
        const contract = new Contract(contractAddress, IERC721Metadata_abi, providers[chain]);
        const result: string = await contract.getFunction('name').staticCall();
        const response: Response<'ERC_721_contract.name'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['ERC_721_contract.symbol']: {
      factor: 1,
      fn: async (request: Request<'ERC_721_contract.symbol'>) => {
        const { requestId, contractAddress, chain } = request;
        const contract = new Contract(contractAddress, IERC721Metadata_abi, providers[chain]);
        const result: string = await contract.getFunction('symbol').staticCall();
        const response: Response<'ERC_721_contract.symbol'> = {
          requestId,
          result,
        };
        return response;
      }
    },
    ['ERC_721_contract.balanceOf']: {
      factor: 2,
      fn: async (request: Request<'ERC_721_contract.balanceOf'>) => {
        const { requestId, contractAddress, chain, walletAddress } = request;
        const contract = new Contract(contractAddress, IERC721Metadata_abi, providers[chain]);
        const [
          result,
          blockNumber,
        ] = await Promise.all([
          contract.getFunction('balanceOf').staticCall(walletAddress) as Promise<bigint>,
          providers[chain].getBlockNumber(),
        ]);
        const response: Response<'ERC_721_contract.balanceOf'> = {
          requestId,
          result: result.toString() as `${number}`,
          blockNumber,
        };
        return response;
      }
    },
    ['ERC_1155_contract.balanceOf']: {
      factor: 2,
      fn: async (request: Request<'ERC_1155_contract.balanceOf'>) => {
        const { requestId, contractAddress, chain, walletAddress, tokenId } = request;
        const contract = new Contract(contractAddress, IERC1155MetadataURI_abi, providers[chain]);
        const [
          result,
          blockNumber,
        ] = await Promise.all([
          contract.getFunction('balanceOf').staticCall(walletAddress, tokenId) as Promise<bigint>,
          providers[chain].getBlockNumber(),
        ]);
        const response: Response<'ERC_1155_contract.balanceOf'> = {
          requestId,
          result: result.toString() as `${number}`,
          blockNumber,
        };
        return response;
      }
    },
    ['ERC_725Y_contract.getData']: {
      factor: 2,
      fn: async (request: Request<'ERC_725Y_contract.getData'>) => {
        const { requestId, contractAddress, chain, key } = request;
        const byteIdent = ethers.keccak256(ethers.toUtf8Bytes(key));
        const contract = new Contract(contractAddress, IERC725Y_abi, providers[chain]);
        const value = await contract.getFunction('getData').staticCall(byteIdent);
        const response: Response<'ERC_725Y_contract.getData'> = {
          requestId,
          value,
        };
        return response;
      }
    },
    ['ERC_725Y_contract.getDataBatch']: {
      factor: 2,
      fn: async (request: Request<'ERC_725Y_contract.getDataBatch'>) => {
        const { requestId, contractAddress, chain, keys } = request;
        const byteIdents = keys.map(key => ethers.keccak256(ethers.toUtf8Bytes(key)));
        const contract = new Contract(contractAddress, IERC725Y_abi, providers[chain]);
        const valuesObj = await contract.getFunction('getDataBatch').staticCall(byteIdents);
        const response: Response<'ERC_725Y_contract.getDataBatch'> = {
          requestId,
          values: valuesObj.toArray(),
        };
        return response;
      }
    },
    ['LSP_7_contract.decimals']: {
      factor: 1,
      fn: async (request: Request<'LSP_7_contract.decimals'>) => {
        const { requestId, contractAddress, chain } = request;
        const contract = new Contract(contractAddress, LSP7_abi, providers[chain]);
        const result: BigInt = await contract.getFunction('decimals').staticCall();
        const response: Response<'LSP_7_contract.decimals'> = {
          requestId,
          result: Number(result),
        };
        return response;
      }
    },
    ['LSP_7_contract.balanceOf']: {
      factor: 2,
      fn: async (request: Request<'LSP_7_contract.balanceOf'>) => {
        const { requestId, contractAddress, chain, walletAddress } = request;
        const contract = new Contract(contractAddress, LSP7_abi, providers[chain]);
        const [
          result,
          blockNumber,
        ] = await Promise.all([
          contract.getFunction('balanceOf').staticCall(walletAddress) as Promise<bigint>,
          providers[chain].getBlockNumber(),
        ]);
        const response: Response<'LSP_7_contract.balanceOf'> = {
          requestId,
          result: result.toString() as `${number}`,
          blockNumber,
        };
        return response;
      }
    },
    ['LSP_8_contract.balanceOf']: {
      factor: 2,
      fn: async (request: Request<'LSP_8_contract.balanceOf'>) => {
        const { requestId, contractAddress, chain, walletAddress } = request;
        const contract = new Contract(contractAddress, LSP8_abi, providers[chain]);
        const [
          result,
          blockNumber,
        ] = await Promise.all([
          contract.getFunction('balanceOf').staticCall(walletAddress) as Promise<bigint>,
          providers[chain].getBlockNumber(),
        ]);
        const response: Response<'LSP_8_contract.balanceOf'> = {
          requestId,
          result: result.toString() as `${number}`,
          blockNumber,
        };
        return response;
      }
    },
    ['getSingleTransactionData']: {
      factor: 2,
      fn: async (request: Request<'getSingleTransactionData'>) => {
        const erc20TransferEventSignature = ethers.id("Transfer(address,address,uint256)");
        const { requestId, chain, txHash } = request;
        const provider = providers[chain];
        const tx = await provider.getTransaction(txHash);
        const receipt = await provider.getTransactionReceipt(txHash)

        if (!tx || !receipt) {
          return {
            found: false,
            transfers: [],
          };
        }

        let transferEvents = receipt.logs.filter(log =>
          log.topics[0] === erc20TransferEventSignature &&
          log.data.length === 66
        );

        // Decode each relevant log
        const transfers = transferEvents.map(log => {
          return {
            type: 'erc20' as const,
            contractAddress: log.address as Common.Address,
            from: ethers.getAddress("0x" + log.topics[1].slice(-40)) as Common.Address,
            to: ethers.getAddress("0x" + log.topics[2].slice(-40)) as Common.Address,
            amount: BigInt(log.data).toString(),
          };
        });

        const response: Response<'getSingleTransactionData'> = {
          requestId,
          initiatorAddress: tx.from as Common.Address,
          found: true,
          transfers,
        };

        if (tx.value > 0n) {
          response.transfers.push({
            type: 'native',
            from: tx.from as Common.Address,
            to: (tx.to as Common.Address) || ethers.ZeroAddress as Common.Address,
            amount: tx.value.toString(),
          });
        }

        return response;
      }
    }
  }

  const tasks = {
    retry: [] as (Request<RPCCallType> & { retries: number })[],
    [OnchainPriority.HIGH]: [] as (Request<RPCCallType> & { retries: number })[],
    [OnchainPriority.MEDIUM]: [] as (Request<RPCCallType> & { retries: number })[],
    [OnchainPriority.LOW]: [] as (Request<RPCCallType> & { retries: number })[],
  };
  let scheduled = 0;
  let finished = 0;
  let retries = 0;
  let nextTimeout: any;
  async function runTask() {
    const task =
      tasks.retry.shift() ||
      tasks[OnchainPriority.HIGH].shift() ||
      tasks[OnchainPriority.MEDIUM].shift() ||
      tasks[OnchainPriority.LOW].shift();

    if (!!task) {
      const handler = handlers[task.type];
      nextTimeout = setTimeout(runTask, BASE_COOLDOWN * handler.factor * settings.NUM_BACKEND_WORKERS);
      try {
        const response = await Promise.race([
          handler.fn(task as any),
          sleep(settings.DEFAULT_PROVIDER_TIMEOUT),
        ]);
        if (!response) {
          throw new Error("Timed out");
        }
        finished++;
        parentPort!.postMessage({
          ...response,
          type: 'success',
        });
      } catch (e: any) {
        if (task.retries < settings.MAX_RETRIES && task.retry === true) {
          retries++;
          task.retries++;
          if (task.retries === settings.WARN_RETRIES) {
            console.warn(`Worker ${workerData.workerId} | Warning at ${settings.WARN_RETRIES} retries for task:`, task);
          }
          tasks.retry.push(task);
          if (!nextTimeout) {
            runTask();
          }
        } else {
          console.warn(`Worker ${workerData.workerId} | Cancelling at ${settings.MAX_RETRIES} retries for task:`, task);
          finished++;
          parentPort!.postMessage({
            type: 'error',
            message: e?.message || 'unknown',
            requestId: task.requestId,
          });
        }
      }
    } else {
      nextTimeout = undefined;
    }
  }

  // Listen for messages from the main thread.
  parentPort!.on('message', (msg: Request<RPCCallType>) => {
    tasks[msg.priority].push({
      ...msg,
      retries: 0,
    });
    scheduled++;
    if (!nextTimeout) {
      runTask();
    }
  });

  parentPort!.postMessage('READY');

  // send stats to parent process every 500ms
  setInterval(() => {
    parentPort!.postMessage({
      type: 'info',
      scheduled,
      finished,
      retries,
    });
  }, 500);
}
// END WORKER CODE

export default o.ethereumApi as EthereumApi;