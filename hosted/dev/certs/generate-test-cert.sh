#!/usr/bin/env bash
# hosted/dev/certs/generate-test-cert.sh — a throwaway CA and server
# certificate for the local and CI stack.
#
# These are NOT production credentials. The production certificate is issued by
# Let's Encrypt on the Pulsar VM (hosted/bootstrap/initial-cert.sh); nothing
# in this directory is ever deployed, and the private key here is published in
# the repository on purpose so that a fresh checkout has a working TLS stack
# with no setup step. It protects nothing.
#
# It fixes two things about the certificate that was here before:
#
#   * there was no CA bundle, so the portability assertion that checks the
#     HTTPS chain could never pass — it needs a ca.pem to point --cacert at;
#   * the certificate had no Subject Alternative Name, so curl refused it
#     with "certificate subject name does not match target host name" even
#     with the CA present. A SAN covering localhost, 127.0.0.1 and the
#     compose hostname is what makes `curl --cacert ca.pem https://127.0.0.1/`
#     succeed.
#
# Run it from anywhere:
#   bash hosted/dev/certs/generate-test-cert.sh
set -euo pipefail

# On Git Bash for Windows, MSYS rewrites a leading slash in an argument into
# a Windows path — so `-subj "/CN=..."` arrives as "C:/Program Files/Git/CN=..."
# and openssl rejects it. Harmless everywhere else, and it means this script
# runs identically on a developer's Windows machine and on the CI runner.
export MSYS_NO_PATHCONV=1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAYS=825

cd "$DIR"

# The CA.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
  -keyout ca.key -out ca.pem \
  -subj "/CN=Brownhill Fleet Test CA/O=Brownhill Fleet (local and CI only)" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# The leaf the server presents.
openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout server.key -out server.csr \
  -subj "/CN=localhost/O=Brownhill Fleet (local and CI only)" 2>/dev/null

cat > server.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:brownhill.localhost,DNS:host.docker.internal,IP:127.0.0.1,IP:::1
EXT

openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 -extfile server.ext 2>/dev/null

rm -f server.csr server.ext ca.srl

chmod 0644 ca.pem server.crt
chmod 0600 ca.key server.key

echo "Wrote $DIR/ca.pem, $DIR/server.crt, $DIR/server.key"
echo "Verify with: curl --cacert $DIR/ca.pem https://127.0.0.1/ -I"
