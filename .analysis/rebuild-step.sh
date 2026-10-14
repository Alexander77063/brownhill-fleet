# /tmp/rebuild-step.sh
echo "=== rebuild with BUILD_STANDALONE=1 ==="
cd /opt/brownhill/repo
export PNPM_HOME=/root/.local/share/pnpm
export PATH="$PNPM_HOME:$PATH"
time BUILD_STANDALONE=1 DEPLOYMENT_PROFILE=standalone pnpm exec next build 2>&1 | tail -10
echo
ls /opt/brownhill/repo/.next/standalone/ 2>&1 | head -10
