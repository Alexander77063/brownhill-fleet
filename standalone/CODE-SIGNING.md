# Signing the Brownhill installer

## Why this is not optional

An unsigned installer is not merely "shows a warning". Measured on the machine this was built on,
**Norton 360 silently deleted the .exe on write** — copying it to Downloads failed with access denied
and the file was simply gone. Mail gateways strip unsigned executables too. An unsigned build is one
that can quietly fail to arrive, and the customer's experience is not "a scary dialog", it is
"the file you sent me isn't there".

The zip workaround survives transit, but every update repeats the friction and it reads as amateur
to a paying client.

---

## The decision

Since June 2023 the private key for a publicly trusted code-signing certificate **must** live on
certified hardware or in a cloud HSM. A `.pfx` file on the build machine is no longer an option for
anyone. So the real choice is which cloud signing service to rent.

| Option | Cost | Notes |
|---|---|---|
| **Azure Artifact Signing** (recommended) | **~$9.99/mo (~£95/yr)** | Microsoft's own service. Signs via API — no hardware token to post around or plug in. Covers UK businesses since GA (April 2026). |
| Certum cloud code signing | ~$108/yr on a 3-year purchase | Cheaper per year if paid up front; a traditional CA. |
| Traditional EV certificate | £250–400/yr | Only reason to pay this is **instant SmartScreen reputation**. |

**What the extra money for EV actually buys:** an EV certificate gets SmartScreen reputation
immediately. A non-EV one earns it over downloads — so early installs may still show
"Windows protected your PC", which the user clicks through via *More info → Run anyway*.

For Brownhill that trade is fine. One named client, installing once, told in advance what to expect.
The thing that actually matters is stopping Norton **deleting** the file, and any valid Authenticode
signature does that. Revisit if this is ever sold to strangers at volume.

---

## Setting up Azure Artifact Signing

Steps 1–4 are yours; **step 3 takes several business days**, so start it before anything else.

### 1. Subscription

An Azure pay-as-you-go subscription. If you already have one for anything else, reuse it.

### 2. Create the signing account

Azure portal → search **Trusted Signing Accounts** (the service is also branded *Artifact Signing*)
→ **Create**.

- Region: **UK South** or **West Europe**.
- Pricing tier: **Basic** — $9.99/mo, 5,000 signatures/month. Nowhere near a limit we'll reach.

Note the **account endpoint**, of the form `https://<region>.codesigning.azure.net`. I need it.

### 3. Identity validation — start this first, it is the long pole

In the account → **Identity Validation** → **New**.

- **As a business:** legal entity name exactly as registered, registered address, website, and a
  verification email address **on the company's own domain**. Microsoft checks the details against
  third-party business records, so the name must match Companies House exactly — an abbreviation or
  a trading name will fail.
- **As a self-employed individual:** government photo ID. Since GA this no longer requires three
  years of trading history.

Expect **1–7 business days**. Nothing can be signed until it completes.

### 4. Certificate profile

Once validation succeeds: → **Certificate Profiles** → **Create** → type **Public Trust**.

The subject name is fixed to the validated identity — you do not get to choose it. **Tell me what it
comes out as**, because of the mismatch trap below.

### 5. Permission to sign

The identity doing the signing needs the **Trusted Signing Certificate Profile Signer** role,
assigned on the signing account (Access control (IAM) → Add role assignment). Assign it to your own
Azure user for signing from your machine, or to a service principal for signing from CI.

Granting yourself Owner on the subscription is **not** sufficient — this role is checked separately,
and its absence shows up as a confusing `403 Forbidden` from signtool rather than a permissions error.

### 6. Build machine prerequisites

- **.NET 8 runtime** — the signing library is .NET, and its absence surfaces as a signtool crash
  rather than a clear message.
- **Windows SDK** — provides `signtool.exe`. Already required to verify signatures.
- **Microsoft.Trusted.Signing.Client** — the NuGet package containing `Azure.CodeSigning.Dlib.dll`.

---

## ⚠ The publisher-name trap

`standalone/tauri/src-tauri/tauri.conf.json` currently sets:

```json
"publisher": "Elite Fleet Management"
```

NSIS embeds that string in the installer. If it does not match the **certificate subject** issued in
step 4, the installer displays one publisher while the signature attests to another — which looks
worse than being unsigned, because it looks like tampering.

This cannot be settled in advance: the subject is whatever Microsoft validates you as. **When step 4
completes, send me the exact subject name and I will align `publisher` to it** before the first
signed build.

---

## What to send me when validation clears

1. The account endpoint (`https://<region>.codesigning.azure.net`)
2. The **account name**
3. The **certificate profile name**
4. The exact **certificate subject** (for the publisher field)

Credentials themselves stay with you — signing authenticates through your Azure login or a service
principal, and nothing secret belongs in this repo. Set them as environment variables on the build
machine only.

---

## Signing a build

Once configured:

```powershell
$env:BF_SIGN_TRUSTED_ENDPOINT = 'https://uksouth.codesigning.azure.net'
$env:BF_SIGN_TRUSTED_ACCOUNT  = '<account name>'
$env:BF_SIGN_TRUSTED_PROFILE  = '<certificate profile name>'
$env:BF_REQUIRE_SIGNED        = '1'   # fail the build rather than ship unsigned

.\standalone\scripts\package.ps1
```

`BF_REQUIRE_SIGNED=1` is the important one for anything you actually send someone: without it a
misconfiguration produces an unsigned installer with a warning buried in ninety minutes of build log.

The build **verifies its own output** — `Assert-Signed` runs `signtool verify /pa` on the finished
installer and fails if the signature did not attach. Tauri reports success either way, and an
installer you believe is signed but is not is worse than one you know is unsigned, because you would
send it.

### Signing without rebuilding

If you have an installer already built and only need it signed, sign it in place rather than
spending ninety minutes rebuilding — see `Invoke-SignFile` in `standalone/scripts/signing.ps1`.

---

## Timestamping

Always on, not configurable off. Without a timestamp the signature stops validating the day the
certificate expires, so a customer installing in two years is back to the warning you paid to remove.

Azure Artifact Signing requires **its own** timestamp authority,
`http://timestamp.acs.microsoft.com` — the DigiCert default used for other modes will not work here.
The build selects the right one automatically.
