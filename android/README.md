# Android (Play Store TWA)

Groovepede ships to Google Play as a Trusted Web Activity: a thin Android shell
that runs the live PWA full-screen. There is no app code here. The only source
of truth is [`twa-manifest.json`](twa-manifest.json); the Gradle project is
regenerated from it on every build and is git-ignored.

The [`android.yml`](../.github/workflows/android.yml) workflow builds a signed
`.aab` (Play) and `.apk` (sideload) and uploads them as a **workflow artifact**.
Uploading to Play is a manual step, so no Play API credential lives in GitHub.

## One-time setup

1. **Make the upload key** (RSA, alias must match `signingKey.alias`). Keep the
   file and both passwords in a password manager, and never commit them:

   ```sh
   keytool -genkeypair -v -keystore upload.keystore -alias groovepede \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. **Create a GitHub environment** named `android-release`
   (Settings → Environments). Add *required reviewers* so a build cannot start
   without approval, and store these as **environment secrets**:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | `base64 -w0 upload.keystore` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_PASSWORD` | the key password |

3. **Merge and deploy this branch first.** `bubblewrap update` downloads the
   icons from `https://groovepede.gregolsky.pl`, so the maskable icon must
   already be live or the build fails.

## Building

Push a tag, or run the workflow manually from the Actions tab:

```sh
git tag android-v1.0.0 && git push origin android-v1.0.0
```

The version name comes from the tag (`x.y.z` only, anything else is rejected).
`versionCode` is the run number, so it always increases, which Play requires.
The run summary prints the upload key's SHA-256 fingerprint.

## The asset-links round trip

The TWA hides the browser URL bar only if
`https://groovepede.gregolsky.pl/.well-known/assetlinks.json` lists the
fingerprint of the key that signed the installed app. **Two** keys are involved:

1. **Upload key**: printed in the workflow summary. Covers the sideloaded `.apk`.
2. **Play App Signing key**: Google re-signs the bundle, so what users install
   from Play carries *this* one. It only exists after your first upload: Play
   Console → Setup → App integrity → App signing key certificate.

Put both in `sha256_cert_fingerprints` in
`frontend/public/.well-known/assetlinks.json` and deploy. Using only the upload
key is the classic mistake: the sideload looks perfect and the Play install
shows a URL bar. The post-deploy smoke test rejects placeholder fingerprints.

## Guards

`npm run test:mobile` (from `frontend/`) fails if `twa-manifest.json` drifts from
the web manifest or `assetlinks.json`. The one that matters most is the package
id: Bubblewrap defaults it to `<id>.twa`, which silently breaks the asset link.

## Security notes

- Bubblewrap is pinned exactly and installed with `npm ci --ignore-scripts`, then
  its registry signatures are verified. Action refs are pinned to commit SHAs.
- Third-party code (npm, Gradle) runs with **no secrets present**. Signing is a
  separate step, with the passwords passed by environment variable, not argv.
- Gradle's distribution is checksum-pinned in the workflow (`GRADLE_SHA256`).
  If a Bubblewrap upgrade changes its Gradle version, the job fails on purpose:
  re-verify the new checksum against gradle.org, then update `GRADLE_URL` and
  `GRADLE_SHA256`.
- Known limits: Gradle resolves libraries from Google Maven / Maven Central
  without Gradle dependency verification, and `npm audit` reports advisories in
  Bubblewrap's transitive deps (`extract-zip`, `jimp`, `file-type`, `uuid`).
  Neither is reachable with how the workflow uses the tool; see the header of
  `android.yml`.

## Running it locally

Needs JDK 17 and the Android SDK (build-tools 36.1.0, platform `android-36`).

```sh
cd android && npm ci --ignore-scripts
npx bubblewrap doctor          # points Bubblewrap at your JDK/SDK
npx bubblewrap update --skipVersionUpgrade
npx bubblewrap build --skipPwaValidation
```
