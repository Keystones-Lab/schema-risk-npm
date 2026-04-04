# Schema-Risk

> **Stop dangerous database migrations before they reach production.**

Schema-Risk is a production-grade PostgreSQL migration safety analyzer for Node.js.
It understands your SQL migrations the way a senior DBA would — flags dangerous
operations, calculates risk scores via hash-table simulation, generates safe
alternatives, and reports findings in multiple formats including SARIF for GitHub
Security integration.

---

## Why Schema-Risk

Schema migrations fail in production for predictable reasons:

- `ALTER TABLE … ALTER COLUMN TYPE` rewrites the entire table under an exclusive lock
- `CREATE INDEX` without `CONCURRENTLY` blocks all writes for the duration of the build
- `DROP COLUMN` breaks application code before the column is actually removed
- `ADD COLUMN NOT NULL` fails instantly on tables with existing rows
- `ADD COLUMN DEFAULT` on PostgreSQL ≤ 10 rewrites the table; on PG 11+ it's metadata-only

Schema-Risk detects **all** of these, explains exactly why they are dangerous, and
gives you the step-by-step safe alternative.

---

## Features

| Feature | Description |
|---|---|
| **Hash-table simulation engine** | Models your entire schema as a high-performance hash table; every DDL statement produces tracked deltas |
| **Risk scoring** | Every operation scored by severity, table size, and PG version |
| **PG version-aware rules** | `ADD COLUMN DEFAULT` behaves differently on PG 10 vs PG 11+ — Schema-Risk knows this |
| **Safe migration generator** | Not just "danger detected" — gives you the exact zero-downtime SQL |
| **Schema drift detection** | Compares migration files against a baseline to find drift |
| **SARIF output** | GitHub Security tab integration via SARIF 2.1.0 |
| **CI/PR reports** | Posts migration risk reports as GitHub PR comments |
| **Multiple output formats** | Terminal, JSON, Markdown, SARIF |
| **Dual CJS/ESM** | Works everywhere — CommonJS and ES Modules |

---

## Installation

```bash
# npm
npm install -g @schema-risk/cli

# npx (no install)
npx @schema-risk/cli analyze migrations/001_add_index.sql
```

### Programmatic Usage

```bash
npm install @schema-risk/cli
```

```typescript
import { analyze, parseSQL } from '@schema-risk/cli';

const sql = `
  ALTER TABLE users ALTER COLUMN email TYPE text;
  CREATE INDEX idx_users_email ON users(email);
`;

const statements = parseSQL(sql);
const report = analyze('migration.sql', statements, { pgVersion: 14 });

console.log(report.overallRisk);  // "HIGH"
console.log(report.score);        // 130
```

---

## Quick Start

```bash
# Analyze a migration file
schema-risk analyze migrations/001_add_index.sql

# Use the correct PostgreSQL version for accurate scoring
schema-risk analyze migrations/001.sql --pg-version 14

# Get safe alternatives as CI-ready Markdown
schema-risk ci-report "migrations/*.sql" --format markdown

# Output SARIF for GitHub Security integration
schema-risk analyze migrations/001.sql --format sarif > results.sarif

# Initialize a config file in your project
schema-risk init
```

---

## Example Output

### Terminal (analyze)

```
──────────────────────────────────────────────────────────────
 SchemaRisk Analysis  migration.sql
──────────────────────────────────────────────────────────────

  Migration Risk:  HIGH   (score: 72)

  Tables affected: users
  Estimated lock duration: ~90 sec
  Index rebuild required: YES
  Requires maintenance window: YES

  Warnings:
    ! CREATE INDEX on 'users' without CONCURRENTLY will hold a SHARE lock
      for the duration of the index build (cols: email)

  Recommendations:
    → CREATE INDEX CONCURRENTLY idx_email ON users(email);

──────────────────────────────────────────────────────────────
  ⛔ This migration should NOT be deployed without review
```

---

## Configuration

Create a `schema-risk.yml` in your project root:

```yaml
version: 2

thresholds:
  fail_on: high       # Exit non-zero at this risk level
  guard_on: medium    # Prompt for confirmation at this level

rules:
  disabled: []        # e.g., ["R03", "R07"]
  table_overrides:
    audit_log:
      max_risk: critical
    sessions:
      ignored: true

output:
  format: terminal    # terminal | json | markdown | sarif
  color: true
  show_recommendations: true
```

Or generate one with:

```bash
schema-risk init
```

---

## Architecture

Schema-Risk uses a **hash-table simulation engine** at its core:

1. **Parse** — SQL migration files are tokenized into structured `ParsedStatement` objects
2. **Simulate** — Each statement is applied against a `SchemaHashTable` (a `Map<string, SchemaEntity>`), producing tracked deltas (additions, modifications, removals)
3. **Score** — Risk rules evaluate each delta and compute severity scores
4. **Report** — Results are formatted for the target output (terminal, SARIF, JSON, Markdown)

The hash-table approach provides O(1) entity lookups, efficient dependency
resolution, and natural modeling of schema loss (removals) and drift (modifications).

---

## Supported Operations

| Operation | Risk | Rule |
|---|---|---|
| `DROP TABLE` | Critical | SR001 |
| `ALTER COLUMN TYPE` | High | SR002 |
| `DROP COLUMN` | High | SR003 |
| `SET NOT NULL` | Medium | SR004 |
| `ADD COLUMN NOT NULL` (no default) | Medium | SR005 |
| `CREATE INDEX` (without `CONCURRENTLY`) | High | SR006 |
| `ADD FOREIGN KEY` | Medium | SR007 |
| `DROP INDEX` | Low | SR008 |
| `RENAME TABLE/COLUMN` | High | SR009 |
| `TRUNCATE` | Critical | SR010 |
| `ADD COLUMN DEFAULT` (PG ≤ 10) | High | SR011 |

---

## CI Integration

### GitHub Actions

```yaml
- name: Analyze migrations
  run: npx @schema-risk/cli analyze "migrations/*.sql" --format sarif --fail-on high > results.sarif

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

### PR Comment

```yaml
- name: Migration report
  run: |
    npx @schema-risk/cli ci-report "migrations/*.sql" --format markdown > report.md
```

---

## API Reference

### `parseSQL(sql: string): ParsedStatement[]`

Parse raw SQL into structured statements.

### `analyze(file: string, statements: ParsedStatement[], options?): MigrationReport`

Run the full risk analysis pipeline.

### `formatReport(report: MigrationReport, format: string): string`

Render a report to the specified format.

### `SchemaHashTable`

The core simulation data structure — a high-performance schema state tracker.

---

## License

[MIT](./LICENSE) — Keystones-Lab
