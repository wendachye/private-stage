# Backend comparison harness

These scripts compare an isolated fictional workload through Node HTTP, Fastify and Next.js. They do not use the application's real databases or Discord credentials. Results are generated locally and ignored by Git.

From the repository root, install dependencies, compile the workload and build the comparison Next.js app:

```powershell
npm ci
npx esbuild benchmarks/backend/workload.ts --bundle --platform=node --format=esm --packages=external --target=node24 --outfile=benchmarks/backend/workload.mjs
node node_modules/next/dist/bin/next build benchmarks/backend/next --webpack
node benchmarks/backend/run.mjs
```

The generated workload bundle and Next.js build must be refreshed after source changes. Synthetic HTTP throughput does not establish room capacity or WebRTC media quality. Use representative participants, tracks and networks for capacity acceptance.
