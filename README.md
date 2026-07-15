# StateWeave AI

Consumer StateWeave experience at [stateweave.ai](https://stateweave.ai).

The interface runs the real [`stateweave/sdk-typescript`](https://github.com/stateweave/sdk-typescript) primitive on the server. Each browser owns a resumable `GraphFrame`; every turn streams graph frames from:

```txt
StateGraph -> GraphFrame -> GraphOps -> StateGraph
```

The graph visualization updates as validated GraphOps are applied. Conversation, graph state, and generated artifacts remain in browser storage for this MVP. The server does not persist chat history.

Self-contained HTML and SVG artifacts are returned as graph-referenced outputs and rendered in a browser iframe with an opaque sandbox origin, no parent-page access, a restrictive Content Security Policy, and no ordinary fetch/connect access. The commercial runtime does not expose filesystem or shell tools.

`stateweave.ai` is not routed through the separate NVIDIA OpenShell alpha MVP. OpenShell remains an isolated evaluation runtime until its reliability and upgrade path are proven; generated web artifacts use the browser sandbox described above.

## Development

The Docker build pins and compiles the canonical SDK commit declared in `Dockerfile`. For local development:

```bash
cd /root/projects/sdk-typescript
pnpm build

cd /root/projects/stateweave-ai
./scripts/sync-stateweave-sdk.sh
npm install
npm run dev
```

Set the supported Anthropic environment variables server-side. Never expose the provider key through `NEXT_PUBLIC_*` variables.

## Checks

```bash
npm run lint
npm run build
```
