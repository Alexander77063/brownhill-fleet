// tests/helpers/server-only-stub.ts
//
// Empty stub for `import 'server-only'`. The real package throws when it
// detects a non-Server Component context — by design — but vitest runs in
// Node, so the throw would mask the test under it. The build-time effect
// (preventing the module from being bundled into a client component) is
// preserved here purely by the `import 'server-only'` side effect itself
// running at Next.js compile time; vitest never sees that path.
export {};
