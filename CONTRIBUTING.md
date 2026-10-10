# Contributing

This package is the mock server. The rest of the repository is a separate application. Changes here should keep that boundary: do not import the backend, the frontend, or the other packages.

## Setup

Node.js 24 or newer.

From this directory, not the repository root:

```bash
npm install
npm test
npm run lint
npm run build
```

`npm test` runs Vitest with coverage. `npm run lint` typechecks `src/` and `tests/`. `npm run build` writes `dist/`.

Install the command locally with `npm run install-cli`. Remove it with `npm uninstall -g @mockmarlin/mock-engine`.

## Where code goes

| Path | What it holds |
|---|---|
| `src/constants.ts` | Ports, host, workspace name, spec filenames, and the init template |
| `src/types.ts` | Options and request types for the Fastify plugin |
| `src/*-types.ts` and `src/app/*-types.ts` | Shapes other modules construct or return |
| `src/` | Behavior: parsing, routing, handlers, the CLI |
| `tests/` | Vitest tests against a real Fastify app |
| `docs/` | Field guides. Update the guide when a public option or spec field changes |
| `examples/` | A sample spec and proto |

Import a constant or a type from those files instead of declaring a second copy.

## Comments

One comment on a function or a type, saying what it does. Leave the copyright header in place. Do not comment a line that only repeats the code. An inline comment is for a case that would otherwise look like a mistake, such as swallowing an inspector error so the mock response still goes out.

## A change

Add or update a test for the behavior you change. Run `npm test` and `npm run lint` before opening a pull request. Do not commit `.env` files, `dist/`, or the tool directories listed in `.gitignore`.
