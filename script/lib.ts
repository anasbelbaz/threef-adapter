import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const { BF_API_BASE_URL, RPC_URL, BF_API_KEY, BOT_KEY_FILE } = process.env;
if (!BF_API_BASE_URL || !RPC_URL || !BF_API_KEY || !BOT_KEY_FILE)
  throw new Error('set BF_API_BASE_URL, RPC_URL, BF_API_KEY and BOT_KEY_FILE');

export const bot = privateKeyToAccount(fs.readFileSync(BOT_KEY_FILE, 'utf8').trim() as Hex);
export const pub = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
export const wallet = createWalletClient({ account: bot, chain: sepolia, transport: http(RPC_URL) });
export const chainId = sepolia.id;
export const auth = { 'x-api-key': BF_API_KEY };
const domain = { name: 'grunt-api', version: '1', chainId } as const;

export const now = () => BigInt(Math.floor(Date.now() / 1000));
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const usdc = (n: number) => BigInt(Math.round(n * 1e6));

export const adapterAbi = parseAbi(['function lend(address request, uint128 maxPt, uint128 minYt) returns (uint256, uint256)']);
export const requestAbi = parseAbi([
  'function mintAuthorization(address) view returns (uint128 ptAmount, uint128 ytAmount)',
  'function asset() view returns (address)',
  'function balancesOf(address) view returns (uint256, uint256)',
]);
export const erc20Abi = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)']);

export interface Auction {
  id: number;
  requestId: Address;
  status: string;
  maxRate: number;
  solve_start_time: string;
}
export interface Offer {
  id: number;
  status: string;
  maker: Address;
  pendingAmount: string;
  filledAmount: string;
  mintDeadline: string | null;
}

export async function api<T = any>(method: 'GET' | 'POST', p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BF_API_BASE_URL}/v1${p}`, {
    method,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers: { 'content-type': 'application/json', ...opts.headers },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export async function ok<T = any>(method: 'GET' | 'POST', p: string, opts?: Parameters<typeof api>[2]): Promise<T> {
  const r = await api<T>(method, p, opts);
  if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function send(label: string, tx: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await wallet.writeContract(tx);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  log(label, receipt.status, hash);
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
  return receipt;
}

export async function deployAdapter(): Promise<Address> {
  const art = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../out/ThreeFAdapter.sol/ThreeFAdapter.json'), 'utf8'));
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [bot.address] });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  if (!contractAddress) throw new Error('deploy failed');
  log('deployed adapter', contractAddress, hash);
  return getAddress(contractAddress);
}

export const getBroker = async () => (await ok<{ facilitator: Address }>('GET', '/facilitator/offer-address', { headers: auth })).facilitator;

export async function enroll(broker: Address, maker: Address) {
  const deadline = now() + 600n;
  const signature = await bot.signTypedData({
    domain,
    primaryType: 'EnrollMaker',
    types: { EnrollMaker: [{ name: 'broker', type: 'address' }, { name: 'maker', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    message: { broker, maker, deadline },
  });
  await ok('POST', '/facilitator/makers', { headers: auth, body: { chainId, maker, deadline: deadline.toString(), signature } });
  log('enrolled', maker);
}

export interface PushTerms {
  maker: Address;
  auctionId: number;
  request: Address;
  amount: bigint;
  expectedReturn: bigint;
  nonce: bigint;
  expiration: bigint;
}

/** Signs SubmitPushOffer with the bot and posts it without an API key. */
export async function submitPush(t: PushTerms) {
  const authorizationDeadline = now() + 600n;
  const signature = await bot.signTypedData({
    domain,
    primaryType: 'SubmitPushOffer',
    types: { SubmitPushOffer: [
      { name: 'action', type: 'string' }, { name: 'executionMode', type: 'string' }, { name: 'maker', type: 'address' },
      { name: 'auctionId', type: 'uint256' }, { name: 'request', type: 'address' }, { name: 'chainId', type: 'uint256' },
      { name: 'amount', type: 'uint256' }, { name: 'expectedReturn', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
      { name: 'expiration', type: 'uint256' }, { name: 'useCallback', type: 'bool' }, { name: 'authorizationDeadline', type: 'uint256' },
    ] },
    message: { action: 'SUBMIT_PUSH_OFFER', executionMode: 'PUSH', ...t, auctionId: BigInt(t.auctionId), chainId: BigInt(chainId),
      useCallback: false, authorizationDeadline },
  });
  return api<{ id: number }>('POST', '/offer', { body: {
    executionMode: 'PUSH', chainId, auctionId: t.auctionId, maker: t.maker, amount: t.amount.toString(),
    expectedReturn: t.expectedReturn.toString(), nonce: t.nonce.toString(), expiration: t.expiration.toString(),
    useCallback: false, authorizationDeadline: authorizationDeadline.toString(), pushAuthorizationSignature: signature,
  } });
}

export const brokerOffers = async (broker: Address) => ok<Offer[]>('GET', `/offer?maker=${broker}`, { headers: auth });
export const openAuctions = async () => (await ok<Auction[]>('GET', '/auction')).filter(a => a.status === 'OPEN')
  .sort((a, b) => Date.parse(a.solve_start_time) - Date.parse(b.solve_start_time));
/** maxRate is in bps; pct is a percentage of it. */
export const returnAt = (a: Auction, amount: bigint, pct: number) => amount * BigInt(Math.floor(a.maxRate * pct)) / 1_000_000n;
