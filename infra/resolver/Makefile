# Groovepede Resolver — key pair generation.
.PHONY: keygen

# Outputs the private key (for VITE_GP_PRIVATE_KEY) and public key (for
# GP_PUBLIC_KEY). Store the private key securely — it goes in .env.local (or
# CI secret) for the PWA build, and the public key here in .env.
keygen:
	@echo "Generating ECDSA P-256 key pair..."
	@openssl ecparam -name prime256v1 -genkey -noout -out /tmp/gp-ec.pem 2>/dev/null
	@echo ""
	@echo "=== VITE_GP_PRIVATE_KEY (add to .env.local + GitHub Actions secret) ==="
	@openssl pkcs8 -topk8 -nocrypt -in /tmp/gp-ec.pem -outform DER 2>/dev/null | base64 -w0
	@echo ""
	@echo ""
	@echo "=== GP_PUBLIC_KEY (add to .env here) ==="
	@openssl ec -in /tmp/gp-ec.pem -pubout -outform DER 2>/dev/null | base64 -w0
	@echo ""
	@rm -f /tmp/gp-ec.pem
	@echo ""
	@echo "Key pair generated. The private key is NOT saved to disk."
