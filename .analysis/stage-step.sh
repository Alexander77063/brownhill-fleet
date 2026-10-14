# /tmp/stage-step.sh
echo "=== stage ==="
SRC=/opt/brownhill/repo/.next/standalone
DST=/var/lib/brownhill/app
rm -rf "$DST"
mkdir -p "$DST"
cp -r "$SRC"/. "$DST"/
cp -r /opt/brownhill/repo/.next/static "$DST"/.next/static
cp -r /opt/brownhill/repo/public "$DST"/public
mkdir -p "$DST"/.next
chown -R brownhill:brownhill "$DST"
ls -la "$DST" | head
