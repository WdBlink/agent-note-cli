# Contributing

Report a reproducible issue or open a focused pull request. Include the CLI and Node.js versions, operating system, command, and a small synthetic transcript when relevant. Remove secrets and personal conversation content.

```sh
npm ci
npm run check
```

Keep client changes in `src/`. Do not introduce a separate summary prompt or parser: `backend/upstream/` contains the unchanged App backend, protected by source hashes. Fix shared behavior in Agent Notebook and use `scripts/sync-backend.mjs` to import it. See [backend development](docs/backend.md).

Tests must use temporary data and simulated model responses. Real provider calls and public publishing are separate, explicitly requested operations. Do not change personal model defaults or real provider logs to make tests pass.
