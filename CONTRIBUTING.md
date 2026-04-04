# Contributing to Schema-Risk

Thank you for your interest in contributing to Schema-Risk! This guide will help you
get started with the development workflow.

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/Keystones-Lab/schema-risk-npm.git
cd schema-risk-npm

# Install dependencies
npm install

# Run the test suite
npm test

# Build the project
npm run build
```

## Development Workflow

### Branch Naming

- `feat/<name>` — new features
- `fix/<name>` — bug fixes
- `docs/<name>` — documentation only
- `refactor/<name>` — code refactoring
- `test/<name>` — test-only changes

### Making Changes

1. Fork the repository and create a feature branch from `main`.
2. Write your code following the existing style (TypeScript strict mode).
3. Write or update tests for every change. Tests live in `__tests__/`.
4. Ensure all checks pass:

```bash
npm run typecheck   # TypeScript type checking
npm run lint        # ESLint
npm run format:check # Prettier
npm test            # Vitest
```

5. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add new risk rule for TRUNCATE`
   - `fix: correct score calculation for PG10 ADD COLUMN DEFAULT`
   - `docs: improve CLI usage examples`
   - `test: add edge cases for dollar-quoted SQL parsing`

6. Open a Pull Request against `main`.

### Project Architecture

```
src/
├── cli/           CLI entry point (Commander)
├── config/        Configuration file loading + validation
├── engine/        Core hash-table simulation engine
│   ├── schema-hash-table.ts   Schema state as a Map
│   ├── simulator.ts           DDL statement applier + delta tracker
│   └── differ.ts              Drift detection via hash-table diffing
├── parser/        SQL DDL tokenizer → ParsedStatement
├── rules/         Risk scoring rules applied to simulation deltas
├── formatters/    Output renderers (terminal, SARIF, JSON, Markdown)
├── types.ts       All shared TypeScript interfaces and enums
└── index.ts       Public library API
```

### Key Design Principles

1. **Hash-table simulation**: The core engine models the entire schema as a
   `Map<string, SchemaEntity>`. Every DDL statement mutates this map and
   produces a tracked delta (addition, modification, or removal).

2. **Pure functions for rules**: Each risk rule is a pure function that
   receives a `SchemaDelta` and returns scored `DetectedOperation[]`.

3. **Separation of concerns**: CLI parsing, engine simulation, risk analysis,
   and output formatting are fully decoupled layers.

4. **No side effects in the engine**: The simulation engine never reads files,
   touches the network, or writes to stdout. All I/O is handled at the CLI layer.

### Adding a New Risk Rule

1. Define the rule function in `src/rules/index.ts`.
2. Add it to the `RULES` array.
3. Write tests in `__tests__/rules.test.ts`.
4. Update `src/formatters/sarif.ts` with a new SARIF rule entry if needed.

### Running a Subset of Tests

```bash
# Run only engine tests
npx vitest run __tests__/engine.test.ts

# Run tests matching a pattern
npx vitest run -t "DROP TABLE"
```

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the
[Contributor Covenant](https://www.contributor-covenant.org/) code of conduct.

## Reporting Issues

- Use the GitHub Issues tab.
- Include: Node.js version, OS, the SQL file that triggered the issue, and
  the full terminal output.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
