# threef-adapter

Test maker contract for 3F multi-maker signed PUSH (3F-538).

`ThreeFAdapter` is an EIP-1271 maker: a bot key signs the API messages (`EnrollMaker`, `SubmitPushOffer`, `GetOffers`, `CancelOffer`) and the contract validates them. After the auction accepts an offer, the bot calls `lend`, which approves and `Request.mint`s the contract's own on-chain authorization (`mintAuthorization(address(this))`). After repayment, `unlock` burns PT/YT.

## Run

```sh
forge test
forge build && npm install   # Node >= 23.6 runs the .ts scripts directly
npm run typecheck

export BF_API_BASE_URL=...   # BF API host
export RPC_URL=...           # Sepolia RPC
export BF_API_KEY=...        # broker API key
export BOT_KEY_FILE=...      # file holding the bot private key (needs Sepolia ETH)

npm run e2e -- [adapter]                 # one offer: deploy, enroll, submit, mint
ADAPTER_A=0x... npm run batch            # scenario batch + watcher
npm run batch -- --watch                 # resume the watcher from batch-state.json
```

`script/lib.ts` holds the shared clients, typed data and API helpers.


Both scripts assume a test deposit token with an open `mint(address,uint256)`.

## Batch scenarios

Uses the three soonest OPEN auctions (X, Y, Z):

| Case | Auction | Checks |
|---|---|---|
| `agg-A1`, `agg-A2` | X | two offers from one maker aggregate into one `mintAuthorization` |
| `multi-B` | X | a second contract maker on the same auction |
| `no-mint-A` | Y | accepted but never minted: timeout / revocation path |
| `expired-B` | Y | expiration before solve start: never selected |
| `other-B` | Z | another auction for maker B |

The watcher mints every accepted case except `no-mint-A`, probes cancel on `AWAITING_MINT` (expects a conflict), and prints a summary.
