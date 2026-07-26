# StateWeave AI

Consumer StateWeave experience at [stateweave.ai](https://stateweave.ai).

The interface runs the public [`stateweave/sdk-typescript`](https://github.com/stateweave/sdk-typescript) `Agent` with the Causal Weave v3 engine. Each browser owns a resumable `AgentState`; every turn runs:

```txt
immutable causal graph -> bounded working context -> ordinary model action -> causal graph
```

The graph visualization updates as causal state is compiled and committed. The runtime can preserve built-in `memory`, `preference`, `wisdom`, and `artifact` semantic nodes, plus bounded agent-created types, inside the same model action without a separate classification call. Conversation, causal state, and generated artifacts remain in browser storage for this MVP. The server does not persist chat history. Active runs use a bounded, five-minute in-memory event buffer keyed by an unguessable run id so a browser refresh can reconnect without cancelling or duplicating the model call; this buffer is transient and never written to disk.

Self-contained HTML and SVG artifacts are returned as typed semantic nodes and rendered in a browser iframe with an opaque sandbox origin, no parent-page access, a restrictive Content Security Policy, and no ordinary fetch/connect access. The commercial runtime does not expose filesystem or shell tools.

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
