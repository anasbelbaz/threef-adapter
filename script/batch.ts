// Batch of signed PUSH scenarios, then a watcher that mints accepted offers.
// Usage: ADAPTER_A=0x... npm run batch        resume the watcher: npm run batch -- --watch
// Assumes a test deposit token with an open mint(address,uint256).
import fs from 'node:fs';
import path from 'node:path';
import { getAddress, type Address } from 'viem';
import {
  adapterAbi, api, auth, brokerOffers, deployAdapter, enroll, erc20Abi, getBroker, log, now, openAuctions, pub, requestAbi,
  returnAt, send, sleep, submitPush, usdc, type Auction, type Offer,
} from './lib.ts';

const STATE_FILE = process.env.STATE_FILE ?? path.join(import.meta.dirname, '../batch-state.json');
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED']);

interface Case {
  name: string;
  auctionId: number;
  request: Address;
  maker: Address;
  amount: string;
  expectedReturn: string;
  nonce: string;
  expiration: string;
  mint: boolean;
  id?: number;
  final?: Offer;
}
interface State { broker: Address; makers: Record<string, Address>; cases: Case[]; lent?: string[] }

const save = (state: State) => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

async function setup(): Promise<State> {
  if (!process.env.ADAPTER_A) throw new Error('set ADAPTER_A');
  const A = getAddress(process.env.ADAPTER_A);
  const broker = await getBroker();
  const B = await deployAdapter();
  await enroll(broker, B);

  // Three soonest OPEN auctions: X gets the multi-maker/aggregation cases, Y the no-mint/expiry cases, Z one more maker B offer.
  const open = await openAuctions();
  if (open.length < 3) throw new Error(`need 3 OPEN auctions, found ${open.length}`);
  const [X, Y, Z] = open as [Auction, Auction, Auction];
  log('auctions', { X: X.id, Y: Y.id, Z: Z.id });
  const asset = await pub.readContract({ address: getAddress(X.requestId), abi: requestAbi, functionName: 'asset' });
  for (const maker of [A, B]) await send(`mint 200 test USDC to ${maker}`, { address: asset, abi: erc20Abi, functionName: 'mint', args: [maker, usdc(200)] });

  const base = Date.now();
  const mk = (name: string, a: Auction, maker: Address, amount: number, pctOfMax: number, extra: Partial<Case> = {}): Case => {
    const amt = usdc(amount);
    return { name, auctionId: a.id, request: getAddress(a.requestId), maker, amount: amt.toString(),
      expectedReturn: returnAt(a, amt, pctOfMax).toString(), nonce: String(base + Math.floor(Math.random() * 1e6)),
      expiration: (now() + 3n * 3600n).toString(), mint: true, ...extra };
  };
  const solveAt = (a: Auction) => BigInt(Math.floor(Date.parse(a.solve_start_time) / 1000));
  const cases = [
    mk('agg-A1', X, A, 40, 10),
    mk('agg-A2', X, A, 30, 20),
    mk('multi-B', X, B, 20, 15),
    mk('no-mint-A', Y, A, 20, 10, { mint: false }),
    mk('expired-B', Y, B, 20, 10, { expiration: (solveAt(Y) - 300n).toString() }),
    mk('other-B', Z, B, 30, 10),
  ];
  for (const c of cases) {
    const r = await submitPush({ ...c, amount: BigInt(c.amount), expectedReturn: BigInt(c.expectedReturn), nonce: BigInt(c.nonce),
      expiration: BigInt(c.expiration) });
    log(`submit [${c.name}]`, r.status, JSON.stringify(r.body));
    if (r.status === 201) c.id = r.body.id;
  }
  const state = { broker, makers: { A, B }, cases };
  save(state);
  return state;
}

/** Mints the maker's aggregate for this Request once; bounds come from our own offers on it. */
async function lend(c: Case, live: Case[]) {
  const mine = live.filter(x => x.maker === c.maker && x.request === c.request);
  const [pt, yt] = await pub.readContract({ address: c.request, abi: requestAbi, functionName: 'mintAuthorization', args: [c.maker] });
  if (pt === 0n) return false;
  const maxPt = mine.reduce((s, x) => s + BigInt(x.amount), 0n);
  const minRate = mine.map(x => [BigInt(x.expectedReturn), BigInt(x.amount)] as const)
    .reduce((m, r) => (r[0] * m[1] < m[0] * r[1] ? r : m));
  const minYt = pt * minRate[0] / minRate[1];
  log(`[${c.name}] mintAuthorization pt=${pt} yt=${yt} maxPt=${maxPt} minYt=${minYt}`);
  await send(`[${c.name}] lend`, { address: c.maker, abi: adapterAbi, functionName: 'lend', args: [c.request, maxPt, minYt > 0n ? minYt - 1n : 0n] });
  log(`[${c.name}] PT/YT`, await pub.readContract({ address: c.request, abi: requestAbi, functionName: 'balancesOf', args: [c.maker] }));
  return true;
}

async function watch(state: State) {
  const live = state.cases.filter(c => c.id);
  const lent = new Set(state.lent ?? []);
  const seen: Record<number, string> = {};
  const cancelProbed = new Set<number>();
  for (const start = Date.now(); Date.now() - start < 6 * 3600_000; await sleep(30_000)) {
    let offers: Record<number, Offer>;
    try { offers = Object.fromEntries((await brokerOffers(state.broker)).map(o => [o.id, o])); }
    catch (e) { log('poll error', (e as Error).message); continue; }
    for (const c of live) {
      const o = offers[c.id!];
      if (!o) continue;
      const view = `${o.status} pending=${o.pendingAmount} filled=${o.filledAmount} mintDeadline=${o.mintDeadline}`;
      if (seen[o.id] !== view) log(`[${c.name}] #${o.id}`, view);
      seen[o.id] = view;
      c.final = o;
      if (o.status !== 'AWAITING_MINT') continue;

      if (!cancelProbed.has(o.id)) {
        cancelProbed.add(o.id);
        const r = await api('POST', '/offer/cancel', { headers: auth, body: { offerId: o.id, maker: state.broker } });
        log(`[${c.name}] cancel while AWAITING_MINT ->`, r.status, JSON.stringify(r.body));
      }
      const key = `${c.maker}:${c.request}`;
      if (!c.mint || lent.has(key)) continue;
      try {
        if (await lend(c, live)) lent.add(key);
      } catch (e) {
        log(`[${c.name}] lend failed`, (e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
      }
    }
    state.lent = [...lent];
    save(state);
    if (live.every(c => c.final && TERMINAL.has(c.final.status))) break;
  }
  log('SUMMARY');
  for (const c of live) log(`  [${c.name}] #${c.id} ${c.final?.status} filled=${c.final?.filledAmount} pending=${c.final?.pendingAmount}`);
  for (const c of state.cases.filter(c => !c.id)) log(`  [${c.name}] not submitted`);
}

await watch(process.argv.includes('--watch') ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State : await setup());
