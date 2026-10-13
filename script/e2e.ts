// One signed PUSH offer from a contract maker, end to end:
// deploy adapter -> fund with test USDC -> enroll -> submit -> wait AWAITING_MINT -> lend -> wait SUCCEEDED.
// Usage: npm run e2e -- [adapterAddress]
import { getAddress, type Address } from 'viem';
import {
  adapterAbi, bot, brokerOffers, deployAdapter, enroll, erc20Abi, getBroker, log, now, openAuctions, pub, requestAbi,
  returnAt, send, sleep, submitPush, usdc, type Offer,
} from './lib.ts';

const AMOUNT = usdc(Number(process.env.AMOUNT_USDC ?? 50));
const RATE_PCT_OF_MAX = Number(process.env.RATE_PCT_OF_MAX ?? 10); // cheap, so the engine selects it

log('bot', bot.address, 'ETH', Number(await pub.getBalance({ address: bot.address })) / 1e18);
const adapter: Address = process.argv[2] ? getAddress(process.argv[2]) : await deployAdapter();

const [auction] = await openAuctions();
if (!auction) throw new Error('no OPEN auction right now');
const request = getAddress(auction.requestId);
const asset = await pub.readContract({ address: request, abi: requestAbi, functionName: 'asset' });
log('auction', auction.id, 'request', request, 'maxRate', auction.maxRate, 'asset', asset);
await send('mint test USDC to adapter', { address: asset, abi: erc20Abi, functionName: 'mint', args: [adapter, AMOUNT * 2n] });

const broker = await getBroker();
await enroll(broker, adapter);

const expectedReturn = returnAt(auction, AMOUNT, RATE_PCT_OF_MAX);
const r = await submitPush({ maker: adapter, auctionId: auction.id, request, amount: AMOUNT, expectedReturn,
  nonce: BigInt(Date.now()), expiration: now() + 3600n });
if (r.status !== 201) throw new Error(`submit -> ${r.status} ${JSON.stringify(r.body)}`);
const { id } = r.body;
log('offer', id, 'amount', AMOUNT, 'expectedReturn', expectedReturn);

const read = async () => (await brokerOffers(broker)).find(o => o.id === id)!;
async function waitFor(done: (o: Offer) => boolean, minutes: number) {
  let offer = await read();
  let last = '';
  for (const start = Date.now(); Date.now() - start < minutes * 60_000; await sleep(15_000)) {
    offer = await read();
    if (offer.status !== last) log('status', offer.status, JSON.stringify(offer));
    last = offer.status;
    if (done(offer)) break;
  }
  return offer;
}

let offer = await waitFor(o => ['AWAITING_MINT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(o.status), 60);
if (offer.status !== 'AWAITING_MINT') throw new Error(`stopped at ${offer.status}`);

// Mint the on-chain aggregate. Slippage bounds come from our offer terms, not from the chain state they guard.
const [pt, yt] = await pub.readContract({ address: request, abi: requestAbi, functionName: 'mintAuthorization', args: [adapter] });
log('mintAuthorization', pt, yt, 'mintDeadline', offer.mintDeadline);
const minYt = pt * expectedReturn / AMOUNT;
await send('adapter.lend', { address: adapter, abi: adapterAbi, functionName: 'lend', args: [request, AMOUNT, minYt > 0n ? minYt - 1n : 0n] });
log('adapter PT/YT', await pub.readContract({ address: request, abi: requestAbi, functionName: 'balancesOf', args: [adapter] }),
  'USDC left', await pub.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [adapter] }));

offer = await waitFor(o => o.status === 'SUCCEEDED', 15);
log(offer.status === 'SUCCEEDED' ? 'DONE: offer SUCCEEDED' : `ended at ${offer.status}`, 'adapter', adapter);
