# Groovepede Resolver Proxy

Server-side Odesli proxy that fixes the CORS block preventing in-browser resolution.
See `specs/resolver-proxy.md` for the full design rationale and architecture.

## Overview

```
Browser → CloudFront (api.groovepede.gregolsky.pl)
        → WAF (token format check + rate limit)
        → /v1/* CacheBehavior → Lambda gp-resolver (Node 22, arm64)
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
- Node.js 18+ and npm (`node --version`)
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

### 3. Request the ACM certificate (out-of-band, us-east-1)

The stack does **not** create the cert — it takes a pre-validated ARN as a parameter.
This is deliberate: letting CloudFormation own the cert caused repeated `CREATE_FAILED`
loops (the ACM resource raced its own DNS validation record, flipped to `FAILED`, and
rollback deleted the cert so the next attempt hit the same race). Managing the cert
separately also means a stack rollback can never destroy a cert that takes time to
re-issue.

```bash
CERT_ARN=$(aws acm request-certificate \
  --domain-name api.groovepede.gregolsky.pl \
  --validation-method DNS --region us-east-1 \
  --query CertificateArn --output text)
```

**⚠ CAA gotcha (this domain specifically):** `groovepede.gregolsky.pl` is a CNAME to
`gregolsky.github.io` (GitHub Pages). When ACM does its CAA check for
`api.groovepede.gregolsky.pl`, the lookup walks up to `groovepede.gregolsky.pl`, follows
that CNAME into `github.io`, and finds GitHub's CAA record — which authorizes only
sectigo / digicert / letsencrypt, **not** Amazon. Result: `CAA_ERROR`, cert fails in
seconds. Fix — add a CAA at the exact `api.` name authorizing Amazon (stops the walk at
the leaf; does not affect the main site):

```bash
aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch '{
  "Changes": [{ "Action": "UPSERT", "ResourceRecordSet": {
    "Name": "api.groovepede.gregolsky.pl", "Type": "CAA", "TTL": 300,
    "ResourceRecords": [
      {"Value": "0 issue \"amazon.com\""}, {"Value": "0 issue \"amazonaws.com\""},
      {"Value": "0 issue \"amazontrust.com\""}, {"Value": "0 issue \"awstrust.com\""}
    ] } }]
}'
```

Add the validation CNAME (ACM's name is deterministic per-domain, so it persists across
re-requests) and wait for issuance:

```bash
# The validation record — read it from the cert and UPSERT it into Route 53:
aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# (UPSERT that Name/Value as a CNAME in the zone, then:)
aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region us-east-1 && echo ISSUED
```

### 4. Deploy the edge stack (us-east-1)

```bash
export HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name gregolsky.pl --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')

make deploy-edge \
  LAMBDA_FUNCTION_URL="$LAMBDA_FUNCTION_URL" \
  LAMBDA_FUNCTION_ARN="$LAMBDA_FUNCTION_ARN" \
  HOSTED_ZONE_ID="$HOSTED_ZONE_ID" \
  CERT_ARN="$CERT_ARN"
```

`make deploy-edge` hard-fails if any of `LAMBDA_FUNCTION_URL`, `HOSTED_ZONE_ID`, or
`CERT_ARN` is unset — `aws cloudformation deploy` never prompts for missing parameters,
it silently uses template defaults, so these are checked up front.

```bash
make outputs-edge
```

### 5. Lock the Lambda permission to the specific distribution

```bash
make lock-permission GP_PUBLIC_KEY="$GP_PUBLIC_KEY"
```

### 6. DNS for the CloudFront distribution

Nothing to do — the Route 53 A-alias (`api.groovepede.gregolsky.pl` → CloudFront) is
created automatically by the edge stack (step 4), gated on `HostedZoneId`.

### 7. Build and deploy the PWA

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

### 8. Smoke test

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

**No AWS Budgets alarm is deployed yet** — this is a planned follow-up, not yet built.

### Cost tracking via tags

Every resource in both stacks that supports tagging carries `App=groovepede-resolver`
(set via `--tags` on `aws cloudformation deploy` in the Makefile — CloudFormation
propagates stack-level tags automatically, no per-resource `Tags:` needed).

Before a tag-scoped Budget can filter by it, the tag must be **activated as a cost
allocation tag** (one-time, manual):
1. Deploy at least once so the tag appears on billed resources
2. Wait ~24h for it to show up in Cost Explorer
3. Billing console → Cost Allocation Tags → activate `App`, or:
   `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status Key=App,Status=Active`

Until that's done, a Budget can only track the whole account, not just this project.

---

## Local development

The proxy accepts `http://localhost:5173` as an allowed CORS origin. Set `VITE_GP_PRIVATE_KEY`
in `.env.local` and point the dev server at the deployed CloudFront URL (already the default
via `ODESLI_BASE = 'https://api.groovepede.gregolsky.pl'`).

To test the Lambda locally, build it and invoke with the AWS CLI:

```bash
cd infra/resolver
make build
# invoke directly (skip CF; useful for a quick sanity check)
node -e "
import('./handler.mjs').then(async m => {
  const res = await m.handler({
    requestContext: { http: { method: 'GET' } },
    headers: { origin: 'http://localhost:5173', 'x-gp-token': '' },
    queryStringParameters: { url: 'https://open.spotify.com/album/0c0hlchA9Q66PcL7xlPPfp', userCountry: 'US' },
  });
  console.log(res.statusCode, res.body.slice(0, 120));
});
"
```

For a full local integration test, temporarily set `ODESLI_BASE = 'http://localhost:3001'`
in `src/js/config.js` and run a minimal HTTP wrapper around the handler.

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
