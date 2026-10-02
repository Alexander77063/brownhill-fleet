import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    /**
     * The profile, exposed to client components.
     *
     * Derived from the same `DEPLOYMENT_PROFILE` the server reads rather than
     * being a second variable someone has to remember to set — two env vars
     * that must agree eventually will not, and the failure here would be a
     * sign-in form offering methods the build cannot perform.
     */
    NEXT_PUBLIC_DEPLOYMENT_PROFILE: process.env.DEPLOYMENT_PROFILE ?? 'saas',
    /**
     * Lets a self-hosted build be branded for a specific customer without a
     * code change. Empty by default; each profile has its own fallback.
     */
    NEXT_PUBLIC_PRODUCT_NAME: process.env.PRODUCT_NAME ?? '',
  },
  // The standalone (Brownhill) build ships a self-contained server that the
  // desktop shell launches with a bundled node.exe — `server.js` plus only the
  // node_modules actually reached, rather than the whole dependency tree.
  //
  // Conditional on an env var rather than always on, because Vercel builds its
  // own output and setting this there is unnecessary; the flag keeps the hosted
  // deployment byte-identical to what it produces today.
  ...(process.env.BUILD_STANDALONE === '1'
    ? {
        output: 'standalone' as const,
        /**
         * Pin the tracing root to this project.
         *
         * Next infers a workspace root by walking up for lockfiles, and then
         * mirrors the project's path *relative to that root* inside
         * `.next/standalone`. Checked out under a deeper path — a git worktree,
         * for instance — the output arrives at
         * `.next/standalone/<those>/<dirs>/server.js` instead of at the top,
         * and the packaging step silently produces an installer with no server
         * in it. Pinning the root makes the layout the same everywhere.
         */
        outputFileTracingRoot: process.cwd(),
        /**
         * Make the app's own origin speak Supabase's REST dialect.
         *
         * `@supabase/supabase-js` builds every data URL as
         * `<base>/rest/v1/<table>`, while PostgREST serves tables at its root.
         * Rewriting here means the 370 `.from()` calls and 25 `.rpc()` calls in
         * `src/` are completely untouched by the standalone build — the client
         * is pointed at this server, and this server forwards to PostgREST.
         *
         * The alternative was swapping the client type at 64 call sites, which
         * is a large diff no test could distinguish from a mistake.
         */
        async rewrites() {
          const postgrest = process.env.POSTGREST_URL ?? 'http://127.0.0.1:55430';
          return [
            { source: '/rest/v1/:path*', destination: `${postgrest}/:path*` },
            // supabase-js probes this for schema information.
            { source: '/rest/v1', destination: postgrest },
          ];
        },
      }
    : {}),
  // The contract-generation route reads the HTML templates in docs/business at
  // runtime; make sure they're traced into the serverless bundle on Vercel.
  outputFileTracingIncludes: {
    '/api/contracts/[agreementId]': ['./docs/business/**'],
  },
  experimental: {
    // Document uploads go through Server Actions, whose request body defaults to 1 MB.
    // `uploadDriverDocument` accepts up to 10 MB, so a PCO licence photographed on a phone
    // — routinely 2-5 MB — was rejected by the framework before the app ever saw it, with a
    // different and equally opaque error. The two ceilings must agree; this is the one the
    // app already promises the user.
    serverActions: { bodySizeLimit: '10mb' },
  },
};

export default nextConfig;
