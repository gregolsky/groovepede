# Groovepede Resolver Proxy

Server-side Odesli proxy that fixes the CORS block preventing in-browser resolution.
See `specs/resolver-proxy.md` for the full design rationale and architecture.

## Overview

```
Browser → CloudFront (api.groovepede.gregolsky.pl)
        → WAF (token format check + rate limit)
        → /v1/* CacheBehavior → Lambda gp-resolver (Node 20, arm64)
          → signature verification (ECDSA-P256, 5-min replay window, URL-bound)
          → DynamoDB cache → Odesli API
```

Two CloudFormation stacks:

| Stack | Template | Region | Contains |
|---|---|---|---|
| `gp-resolver-app` | `template-app.yaml` | eu-central-1 | Lambda + Function URL + DynamoDB |
| `gp-resolver-edge` | `template-edge.yaml` | **us-east-1** | ACM cert + WAF + CloudFront |

### Token scheme

Each `resolveAlbum` call signs a payload of `"${unixSeconds}\n${albumUrl}"` with an
ECDSA-P256 private key embedded in the PWA bundle at build time (from `VITE_GP_PRIVATE_KEY`).
The Lambda verifies the signature using the matching public key (`GP_PUBLIC_KEY` env var).

- **Private key** — never in source; injected via `.env.local` (dev) or GitHub Actions secret (CI)
- **Public key** — safe to store anywhere; passed as a plaintext CloudFormation parameter
- **WAF** — rejects tokens that don't match the format regex at the edge before Lambda wakes up
- **5-minute window** — tokens are URL-bound and expire; a sniffed token can't be replayed

## Prerequisites

- AWS CLI configured (`aws sts get-caller-identity` works)
- AWS SAM CLI installed (`sam --version`)
- `openssl` available (for key generation)
- DNS for `gregolsky.pl` accessible (Route 53 hosted zone ID needed for cert validation)

## First-time deploy

### 1. Generate the key pair

```bash
cd infra/resolver
make keygen
```

This prints two values:
- `VITE_GP_PRIVATE_KEY` — add to `.env.local` and save as a GitHub Actions secret
- `GP_PUBLIC_KEY` — used in the next step; safe to keep in notes/config

```bash
# Save both values, then:
export GP_PUBLIC_KEY=<printed public key>
```

Also add to the PWA `.env.local`:
```
VITE_GP_PRIVATE_KEY=<printed private key>
```

### 2. Deploy the app stack (eu-central-1)

```bash
make deploy-app GP_PUBLIC_KEY="$GP_PUBLIC_KEY"
```

Leave `CloudFrontDistributionArn` empty (it doesn't exist yet). Note the outputs:

```bash
make outputs-app
```

```bash
export LAMBDA_FUNCTION_URL=<FunctionUrl from outputs>
export LAMBDA_FUNCTION_ARN=<FunctionArn from outputs>
```

### 3. Deploy the edge stack (us-east-1)

The edge stack needs no secret parameters — the WAF uses a regex format check, not
the actual token value.

```bash
make deploy-edge LAMBDA_FUNCTION_URL="$LAMBDA_FUNCTION_URL" LAMBDA_FUNCTION_ARN="$LAMBDA_FUNCTION_ARN"
```

When prompted, enter `HostedZoneId` (your Route 53 zone for `gregolsky.pl`).
If you don't use Route 53, leave it empty and validate the ACM cert manually in the
AWS console (Certificate Manager → pending cert → copy the DNS CNAME to your provider).

> **ACM cert validation can take up to 30 minutes.** The stack waits. Don't cancel.

```bash
make outputs-edge
```

### 4. Lock the Lambda permission to the specific distribution

```bash
make lock-permission GP_PUBLIC_KEY="$GP_PUBLIC_KEY"
```

### 5. Set up DNS

Create a CNAME (or Route 53 A-alias) from `resolver.groovepede.gregolsky.pl` to the
`DistributionDomainName` from `make outputs-edge`.

### 6. Build and deploy the PWA

```bash
# From project root:
npm run build && npm test
# deploy as usual (GitHub Pages / your CI)
```

For CI, add `VITE_GP_PRIVATE_KEY` as a GitHub Actions secret:

```yaml
- name: Build
  run: npm run build
  env:
    VITE_GP_PRIVATE_KEY: ${{ secrets.VITE_GP_PRIVATE_KEY }}
```

### 7. Smoke test

```bash
make smoke VITE_GP_PRIVATE_KEY="$VITE_GP_PRIVATE_KEY"
```

Expect: HTTP 200 at `https://api.groovepede.gregolsky.pl/v1/resolve`,
`access-control-allow-origin: https://groovepede.gregolsky.pl` header,
`linksByPlatform` in the JSON body.

---

## Re-deploys / updates

**Lambda code changes only:**
```bash
make build && make deploy-app GP_PUBLIC_KEY="$GP_PUBLIC_KEY"
```

**WAF or CloudFront changes** (edge stack is secret-free, no extra vars needed):
```bash
make deploy-edge LAMBDA_FUNCTION_URL=<url> LAMBDA_FUNCTION_ARN=<arn>
```

**Rotating the key pair:**
1. `make keygen` — generates a new pair
2. `make deploy-app GP_PUBLIC_KEY=<new public key>` — Lambda now expects new signatures
3. Update `VITE_GP_PRIVATE_KEY` in `.env.local` and the GitHub Actions secret
4. Re-build and re-deploy the PWA — old tokens (signed with old key) immediately stop working
5. No edge stack change needed (WAF uses regex, not the key value)

---

## Cost

| Component | Cost |
|---|---|
| WAF WebACL | ~$5/mo |
| WAF rules (3×) | ~$3/mo |
| WAF requests | $0.60/M req |
| CloudFront | free tier (~10 GB transfer/mo free) |
| Lambda | free tier (1M req/mo free) |
| DynamoDB | ~$0 (PAY_PER_REQUEST + aggressive cache) |
| **Total** | **~$8–10/mo** |

An AWS Budgets alarm is configured at $5/mo (80% of expected).

---

## Local development

The proxy accepts `http://localhost:5173` as an allowed CORS origin. Set `VITE_GP_PRIVATE_KEY`
in `.env.local` and point the dev server at the deployed CloudFront URL (already the default
via `ODESLI_BASE = 'https://api.groovepede.gregolsky.pl'`).

To test the Lambda locally without CloudFront:

```bash
cd infra/resolver
npm install
GP_PUBLIC_KEY="$GP_PUBLIC_KEY" sam local start-api --template template-app.yaml --port 3001
```

Then temporarily set `ODESLI_BASE = 'http://localhost:3001'` in `src/js/config.js`
(the path `/v1/resolve` is already in `api.js`, so the full URL becomes
`http://localhost:3001/v1/resolve?url=…`).
The signature verification still runs locally — set `VITE_GP_PRIVATE_KEY` in the shell
so the dev app produces valid tokens.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 {"_error":"forbidden"}` from WAF | `x-gp-token` header missing or wrong format | Check `VITE_GP_PRIVATE_KEY` is set and `sign.js` is imported correctly |
| `403 {"_error":"forbidden"}` from Lambda | Valid format but signature check failed | Verify `GP_PUBLIC_KEY` matches the private key used in the PWA build |
| `403` + token expired | System clock skew > 5 min | Lambda's replay window is ±300 s; check Lambda + client clocks |
| `429` from CloudFront | Per-IP rate limit hit | Wait 5 min; adjust `RateLimitPerIp` param if legitimate traffic |
| `400 {"_error":"unsupported url"}` | URL host not in Lambda allowlist | Add the host to `ALLOWED_HOSTS` in `handler.mjs` and re-deploy |
| `503 {"_error":"network"}` | Lambda can't reach Odesli | No VPC by default = internet access fine; check Odesli status |
| ACM cert stuck `PENDING_VALIDATION` | DNS CNAME not created | Copy CNAME from ACM console to your DNS provider; validates within minutes |
