# hosted/dev/certs — throwaway TLS material for the local and CI stack

**These protect nothing.** They are test fixtures for a stack that runs on a
developer's machine and on a CI runner. The production certificate is issued
by Let's Encrypt on the Pulsar VM — see `hosted/bootstrap/initial-cert.sh` and
`hosted/bootstrap/substitute-fqdn.sh` — and nothing in this directory is ever
deployed.

| File | What it is | Committed? |
| --- | --- | --- |
| `ca.pem` | The test CA's certificate. `curl --cacert ca.pem` trusts it. | yes |
| `server.crt` | The leaf the nginx container presents. | yes |
| `server.key` | The leaf's private key. nginx needs it mounted. | yes |
| `ca.key` | The CA's private key. Only needed to sign new leaves. | **no** — gitignored |

The private keys are committed on purpose. A certificate is only as private
as its CA, and this CA is published here; a key file that is not in the
repository would mean a fresh checkout could not start the stack without a
setup step, and a setup step that people skip is a setup step that fails
silently. These keys authenticate nothing and are valid only for
`localhost`, `127.0.0.1` and `brownhill.localhost`.

## Regenerating

```bash
bash hosted/dev/certs/generate-test-cert.sh
```

It rewrites `ca.pem`, `ca.key`, `server.crt` and `server.key`, and the
certificate it produces covers `localhost`, `127.0.0.1`, `::1`,
`brownhill.localhost` and `host.docker.internal` by name and by address.

## Why the previous certificate was replaced

The certificate that was here before was self-signed, carried **no Subject
Alternative Name**, and shipped with **no CA bundle**. Two consequences:

* `curl --cacert hosted/dev/certs/ca.pem https://127.0.0.1/` failed with
  "certificate subject name does not match target host name" — a missing SAN,
  not a missing CA;
* the portability assertion that checks the HTTPS chain (`assertion 14` in
  `hosted/tests/verify-hosted-portability.sh`) skipped itself, because
  `ca.pem` did not exist.

Both are now real: the chain verifies and the assertion has something to
point at.
