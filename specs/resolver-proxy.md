# Groovepede Resolver Proxy — Spec

**Status:** planned / in implementation  
**Owner:** backend (`infra/resolver/`)  
**Related plan:** `~/.claude/plans/i-ve-added-2-new-jazzy-donut.md`

---

## Problem

Odesli (`api.song.link`) returns `Access-Control-Allow-Origin` only for its own
frontends (`odesli.co`, `song.link`). A browser fetch from
`groovepede.gregolsky.pl` gets a `200` back but **no ACAO header**, so the
browser blocks the response. The app catches the TypeError as
`{ _error: 'network' }`, which is retryable — so pending stubs retry forever and
never resolve.

This affects every album added via any service (not just Spotify), because all
resolution goes through Odesli. The legacy Spotify-direct path is being dropped.

An Odesli API key does **not** fix the problem — CORS is origin-based, not
key-based.

---

## Solution

A server-side Lambda proxy calls Odesli without an `Origin` header, with a named
`User-Agent`, and re-emits the JSON with the correct ACAO header. All resolution
is routed through the proxy. The app's existing Odesli response shape is preserved
exactly, so no client data-model changes are needed.

---

## Architecture

```
Browser (Origin: https://groovepede.gregolsky.pl)
  │  GET /v1/resolve?url=…&userCountry=US
  │  Header: x-gp-token: <signed token>
  ▼
CloudFront  (custom domain: api.groovepede.gregolsky.pl)
  │  ACM cert (us-east-1) · /v1/* CacheBehavior (keyed on url + userCountry + Origin)
  ▼
AWS WAF Web ACL  (scope: CLOUDFRONT, region: us-east-1)
  ├─ Rule 1: block unless x-gp-token == expected value  → 403 at edge
  ├─ Rule 2: per-IP rate limit (100 req / 5 min)        → 429 at edge
  └─ Rule 3: AWS managed IP reputation list             → 403 at edge
  ▼
CloudFront OAC (SigV4-signs origin request)
  ▼
Lambda Function URL  (AuthType: AWS_IAM — only CloudFront OAC can invoke)
  ▼
Lambda gp-resolver  (Node 22, 128 MB, 3 s timeout, concurrency: 3)
  ├─ Input validation: url present + host in allowlist
  ├─ DynamoDB cache check (TTL 60 days)
  │   hit  → return cached body
  │   miss ↓
  ├─ fetch https://api.song.link/v1-alpha.1/links?…
  │   UA: Groovepede-Resolver/1.0 (+https://groovepede.gregolsky.pl)
  │   non-200 → passthrough error (app retry logic handles it)
  └─ Write to DynamoDB · return body
  ▼
DynamoDB gp-resolve-cache  (PAY_PER_REQUEST, TTL on `exp`)
```

---

## Handler contract

**Endpoint:** `GET https://api.groovepede.gregolsky.pl/v1/resolve`  
**Query params:** same as Odesli — `url` (required), `userCountry` (default `US`)  
**Required header:** `x-gp-token: <ts>.<base64url-sig>` (ECDSA-P256 signed; 5-min window; URL-bound)  
**Response shape:** verbatim Odesli JSON on success; `{ "_error": <status> }` on
failure  
**CORS:** `Access-Control-Allow-Origin: https://groovepede.gregolsky.pl` (and
`http://localhost:5173` for dev)

### Cache key

```
k = "links:{userCountry}:{normalizedUrl}"
```

`normalizedUrl` = strip `?si=`, `?utm_*`, and other tracking params while
preserving service-specific params (e.g. Apple Music `/album/name/id` path
segments are path-based, not query-based — no change needed).

### Input allowlist (SSRF hygiene)

The handler rejects any `url` whose host is not one of:

| Service | Hosts |
|---|---|
| Spotify | `open.spotify.com` |
| Apple Music | `music.apple.com` |
| YouTube / YT Music | `music.youtube.com`, `youtube.com`, `www.youtube.com` |
| Deezer | `deezer.com`, `www.deezer.com` |
| Tidal | `tidal.com`, `listen.tidal.com` |
| Amazon Music | `music.amazon.com`, `music.amazon.co.uk`, `music.amazon.de` _(etc.)_ |
| Pandora | `pandora.com`, `www.pandora.com` |
| SoundCloud | `soundcloud.com`, `www.soundcloud.com` |

---

## Security & cost controls

| Control | Layer | Cost |
|---|---|---|
| WAF token rule (x-gp-token) | Edge (CloudFront) | ~$1/rule/mo |
| WAF per-IP rate rule | Edge (CloudFront) | ~$1/rule/mo |
| WAF WebACL baseline | Edge | ~$5/WebACL/mo |
| Lambda Function URL AuthType: AWS_IAM | Origin | free |
| CloudFront OAC | Origin | free |
| Reserved concurrency = 3 | Lambda | free |
| 3 s timeout · 128 MB | Lambda | free |
| DynamoDB PAY_PER_REQUEST + TTL | Cache | ~$0 |
| AWS Budgets alarm ($5/mo threshold) | Account | free |

**Total expected cost: ~$7–10/mo** (WAF-dominated).

**Token caveat:** `VITE_GP_PRIVATE_KEY` ships in the public PWA bundle, so a
determined attacker can mint valid tokens — this is a stronger deterrent than a
static shared secret, but not airtight auth. Tokens sniffed from the wire expire
in 5 min and are URL-bound. The actual hard limits are the WAF rate rule +
reserved concurrency + Budgets.

---

## Client changes (`src/`)

### `src/js/config.js`
```js
export const ODESLI_BASE    = 'https://api.groovepede.gregolsky.pl';
export const GP_PRIVATE_KEY = import.meta.env.VITE_GP_PRIVATE_KEY ?? '';
// Private key: ECDSA-P256 PKCS8 DER, base64-encoded.
// Generate once with: cd infra/resolver && make keygen
// Set in .env.local for dev; VITE_GP_PRIVATE_KEY GitHub Actions secret for CI.
```

### `src/js/sign.js` (new)
Signs each request: `import { signRequestToken } from './sign.js'`  
Returns `"<ts>.<base64url(ECDSA-SHA256 sig over '${ts}\n${url}')>"`.

### `src/js/api.js` — `resolveAlbum` (line ~41)
```js
const res = await fetch(`${ODESLI_BASE}/v1/resolve?${params}`, {
  headers: { 'x-gp-token': await signRequestToken(inputUrl) },
});
```

All four call sites (`resolvePending`, `handleAdd`, boot-share, per-entry refresh)
go through `resolveAlbum` — one change covers them all.

---

## Infrastructure layout

```
infra/resolver/
├── handler.mjs          — Lambda handler (Node 22 ESM)
├── package.json         — declares @aws-sdk/* as external (runtime-provided)
├── template-app.yaml    — SAM: Lambda + DynamoDB (deploy to app region)
├── template-edge.yaml   — CFN: ACM + WAF + CloudFront (deploy to us-east-1)
└── Makefile             — sam build/deploy shortcuts
```

---

## Deploy sequence

```
# 1. Generate key pair (one-time)
cd infra/resolver
make keygen
# → prints VITE_GP_PRIVATE_KEY (add to .env.local + CI secret)
# → prints GP_PUBLIC_KEY (pass to deploy-app)
export GP_PUBLIC_KEY=<printed value>

# 2. Deploy app stack (Lambda + DynamoDB) — eu-central-1
make deploy-app GP_PUBLIC_KEY="$GP_PUBLIC_KEY"

# 3. Deploy edge stack (ACM + WAF + CloudFront) — us-east-1
# HOSTED_ZONE_ID is required: `aws cloudformation deploy` never prompts for
# missing parameters, so an unset HostedZoneId silently defaults to '' and
# disables ACM's auto DNS validation — the cert then hangs PENDING_VALIDATION
# indefinitely instead of failing loudly.
export LAMBDA_FUNCTION_URL=<FunctionUrl from outputs-app>
export LAMBDA_FUNCTION_ARN=<FunctionArn from outputs-app>
export HOSTED_ZONE_ID=<Route 53 zone ID for gregolsky.pl>
make deploy-edge LAMBDA_FUNCTION_URL="$LAMBDA_FUNCTION_URL" LAMBDA_FUNCTION_ARN="$LAMBDA_FUNCTION_ARN" HOSTED_ZONE_ID="$HOSTED_ZONE_ID"

# 4. Lock Lambda permission to the specific distribution
make lock-permission GP_PUBLIC_KEY="$GP_PUBLIC_KEY"

# 5. DNS — the Route 53 A-alias was created automatically in step 3
#    (same HostedZoneId dependency as the ACM validation)

# 6. Build + deploy the PWA
npm run build && npm test
```

---

## Layer 2 (future — UPC-based self-hosted resolver)

When Odesli is unreachable, extend the same Lambda to fan out by UPC:

1. Retrieve UPC from the source service (Spotify `/v1/albums/{id}` → `external_ids.upc`; Spotify app token cached in DynamoDB)
2. Fan out: Deezer `GET /album/upc:{upc}`, iTunes `GET /lookup?upc={upc}`, Spotify `GET /search?q=upc:{upc}`
3. Emit `linksByPlatform` keyed to match `services.js` `odesliKeys`

Gaps: YouTube Music (no UPC lookup), Tidal (needs partner OAuth) — stay Odesli-only.
Not in current scope.

---

## Tests

### Backend (unit)
File: `infra/resolver/handler.test.mjs`

- Cache miss → calls Odesli with app UA + optional key, caches body, returns it
- Cache hit → no Odesli call, returns cached body
- Unknown host in `url` → 400 before any outbound call
- Odesli non-200 → passthrough (same status, `{ _error: status }`)
- Missing `url` param → 400

### App (existing suite — retargeting)
- `src/js/api.test.js`: stub the proxy URL (instead of `api.song.link/**`); confirm all
  existing resolve tests pass
- `tests/add.spec.js` / `tests/share.spec.js`: stub `api.groovepede.gregolsky.pl`
  returning Odesli-shaped fixtures; assert full card renders

### Integration (post-deploy smoke)
```bash
cd infra/resolver
make smoke VITE_GP_PRIVATE_KEY="$VITE_GP_PRIVATE_KEY"
# Calls: GET https://api.groovepede.gregolsky.pl/v1/resolve?url=…
# Expect: 200, access-control-allow-origin header, linksByPlatform in body
```
