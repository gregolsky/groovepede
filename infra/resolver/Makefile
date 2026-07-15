# Groovepede Resolver Proxy — deploy helpers
# Usage: see infra/resolver/README.md and specs/resolver-proxy.md

APP_REGION   := eu-central-1
EDGE_REGION  := us-east-1
APP_STACK    := gp-resolver-app
EDGE_STACK   := gp-resolver-edge

# Before deploying, generate a key pair (one-time):
#   make keygen
# Then set:
#   export GP_PUBLIC_KEY=<printed public key>
#   Add VITE_GP_PRIVATE_KEY to .env.local and as a GitHub Actions secret

# Optional Odesli API key:
#   export ODESLI_KEY=your_key_here

# CloudFront distribution ARN (set after edge stack deploys):
#   export DISTRIBUTION_ARN=arn:aws:cloudfront::123456789012:distribution/ABCDEFG

.PHONY: keygen build deploy-app deploy-edge lock-permission outputs-app outputs-edge smoke

# ── Key pair generation (one-time setup) ─────────────────────────────────────
# Outputs the private key (for VITE_GP_PRIVATE_KEY) and public key (for GP_PUBLIC_KEY).
# Store the private key securely — it goes in .env.local and the CI secret.
# The public key is safe to store anywhere (it's public).

keygen:
	@echo "Generating ECDSA P-256 key pair..."
	@openssl ecparam -name prime256v1 -genkey -noout -out /tmp/gp-ec.pem 2>/dev/null
	@echo ""
	@echo "=== VITE_GP_PRIVATE_KEY (add to .env.local + GitHub Actions secret) ==="
	@openssl pkcs8 -topk8 -nocrypt -in /tmp/gp-ec.pem -outform DER 2>/dev/null | base64 -w0
	@echo ""
	@echo ""
	@echo "=== GP_PUBLIC_KEY (pass to: make deploy-app GP_PUBLIC_KEY=<value>) ==="
	@openssl ec -in /tmp/gp-ec.pem -pubout -outform DER 2>/dev/null | base64 -w0
	@echo ""
	@rm -f /tmp/gp-ec.pem
	@echo ""
	@echo "Key pair generated. The private key is NOT saved to disk."

# ── Build ─────────────────────────────────────────────────────────────────────
# Bundles handler.mjs with esbuild (minified, ESM, @aws-sdk/* kept external),
# then zips the output for `aws cloudformation package` to upload to S3.

build:
	@mkdir -p .build
	npm install --silent
	node_modules/.bin/esbuild handler.mjs \
	  --bundle --platform=node --target=node22 --format=esm \
	  --minify --outfile=.build/handler.mjs \
	  --external:@aws-sdk/client-dynamodb \
	  --external:@aws-sdk/lib-dynamodb
	cd .build && zip -q handler.zip handler.mjs

# ── App stack (eu-central-1): Lambda + DynamoDB ───────────────────────────────

# Phase 1: first deploy (DISTRIBUTION_ARN not yet known — wildcard permission)
# Phase 2: re-run with DISTRIBUTION_ARN=<arn> to lock the permission
# Requires: GP_PUBLIC_KEY (from `make keygen`)
deploy-app: build
	@test -n "$(GP_PUBLIC_KEY)" || (echo "ERROR: set GP_PUBLIC_KEY (from: make keygen)"; exit 1)
	$(eval DEPLOY_BUCKET := gp-resolver-deploy-$(shell aws sts get-caller-identity --query Account --output text))
	aws s3 mb s3://$(DEPLOY_BUCKET) --region $(APP_REGION) 2>/dev/null || true
	aws cloudformation package \
	  --template-file template-app.yaml \
	  --s3-bucket $(DEPLOY_BUCKET) \
	  --region $(APP_REGION) \
	  --output-template-file .build/template-packaged.yaml
	aws cloudformation deploy \
	  --template-file .build/template-packaged.yaml \
	  --stack-name $(APP_STACK) \
	  --region $(APP_REGION) \
	  --capabilities CAPABILITY_IAM \
	  --parameter-overrides \
	    GpPublicKey="$(GP_PUBLIC_KEY)" \
	    OdesliKey="$(ODESLI_KEY)" \
	    CloudFrontDistributionArn="$(DISTRIBUTION_ARN)" \
	  --no-fail-on-empty-changeset

# ── Edge stack (us-east-1): ACM + WAF + CloudFront ───────────────────────────

# Requires: LAMBDA_FUNCTION_URL from `make outputs-app`
# No secret parameters needed — the edge stack is secret-free.
deploy-edge:
	@test -n "$(LAMBDA_FUNCTION_URL)" || (echo "ERROR: set LAMBDA_FUNCTION_URL=<url from outputs-app>"; exit 1)
	aws cloudformation deploy \
	  --template-file template-edge.yaml \
	  --stack-name $(EDGE_STACK) \
	  --region $(EDGE_REGION) \
	  --capabilities CAPABILITY_IAM \
	  --parameter-overrides \
	    LambdaFunctionUrl="$(LAMBDA_FUNCTION_URL)" \
	    LambdaFunctionArn="$(LAMBDA_FUNCTION_ARN)" \
	  --no-fail-on-empty-changeset

# ── Lock the Lambda permission to the specific CloudFront distribution ─────────

lock-permission:
	$(eval DIST_ARN := $(shell aws cloudformation describe-stacks \
	  --stack-name $(EDGE_STACK) \
	  --region $(EDGE_REGION) \
	  --query "Stacks[0].Outputs[?OutputKey=='DistributionArn'].OutputValue" \
	  --output text))
	@echo "Locking Lambda permission to distribution: $(DIST_ARN)"
	$(MAKE) deploy-app DISTRIBUTION_ARN="$(DIST_ARN)"

# ── Show outputs ──────────────────────────────────────────────────────────────

outputs-app:
	aws cloudformation describe-stacks \
	  --stack-name $(APP_STACK) \
	  --region $(APP_REGION) \
	  --query 'Stacks[0].Outputs' \
	  --output table

outputs-edge:
	aws cloudformation describe-stacks \
	  --stack-name $(EDGE_STACK) \
	  --region $(EDGE_REGION) \
	  --query 'Stacks[0].Outputs' \
	  --output table

# ── Smoke test (post-deploy) ──────────────────────────────────────────────────

# Generates a real signed token using the private key and sends a test request.
# Requires: VITE_GP_PRIVATE_KEY set in the shell environment.
smoke:
	@test -n "$(VITE_GP_PRIVATE_KEY)" || (echo "ERROR: set VITE_GP_PRIVATE_KEY"; exit 1)
	@TS=$$(date +%s); \
	 SIG=$$(printf "%s\nhttps://open.spotify.com/album/0c0hlchA9Q66PcL7xlPPfp" "$$TS" \
	   | openssl dgst -sha256 -sign <(openssl pkcs8 -nocrypt -inform DER -in <(echo "$(VITE_GP_PRIVATE_KEY)" | base64 -d)) \
	   | base64 -w0 | tr '+/' '-_' | tr -d '='); \
	 TOKEN="$$TS.$$SIG"; \
	 echo "Token: $$TOKEN"; \
	 curl -si \
	   "https://api.groovepede.gregolsky.pl/v1/resolve?url=https://open.spotify.com/album/0c0hlchA9Q66PcL7xlPPfp&userCountry=US" \
	   -H "Origin: https://groovepede.gregolsky.pl" \
	   -H "x-gp-token: $$TOKEN" \
	 | head -60
	@echo ""
	@echo "--- Expect: HTTP 200 + access-control-allow-origin + linksByPlatform in body"
