# StateWeave AI

Consumer StateWeave experience at [stateweave.ai](https://stateweave.ai).

The interface runs the real [`stateweave/sdk-typescript`](https://github.com/stateweave/sdk-typescript) primitive on the server. Each browser owns a resumable `GraphFrame`; every turn streams graph frames from:

```txt
StateGraph -> GraphFrame -> GraphOps -> StateGraph
```

The graph visualization updates as validated GraphOps are applied. Conversation and graph state remain in browser storage for this MVP. The server does not persist chat history.

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
