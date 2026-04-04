// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — SARIF 2.1.0 Formatter
// ─────────────────────────────────────────────────────────────────────────────

import type { MigrationReport } from '../types.js';
import { RiskLevel } from '../types.js';

interface SarifRule {
  id: string;
  name: string;
  short: string;
  full: string;
}

const SARIF_RULES: SarifRule[] = [
  {
    id: 'SR001',
    name: 'DropTable',
    short: 'DROP TABLE destroys data permanently',
    full: 'DROP TABLE removes the table and all its data permanently. Consider renaming the table first and dropping after a full release cycle.',
  },
  {
    id: 'SR002',
    name: 'AlterColumnType',
    short: 'ALTER COLUMN TYPE causes full table rewrite',
    full: 'Changing a column type requires PostgreSQL to rewrite the entire table under an ACCESS EXCLUSIVE lock, blocking all reads and writes.',
  },
  {
    id: 'SR003',
    name: 'DropColumn',
    short: 'DROP COLUMN is irreversible',
    full: 'Dropping a column is irreversible and holds an ACCESS EXCLUSIVE lock. Deploy app changes first, then drop the column in a follow-up migration.',
  },
  {
    id: 'SR004',
    name: 'SetNotNull',
    short: 'SET NOT NULL requires full table scan',
    full: 'Adding a NOT NULL constraint triggers a full table scan to validate existing rows. Use a check constraint with NOT VALID first.',
  },
  {
    id: 'SR005',
    name: 'AddColumnNoDefault',
    short: 'NOT NULL column without DEFAULT fails on non-empty tables',
    full: 'Adding a NOT NULL column without a default value fails immediately if the table has existing rows.',
  },
  {
    id: 'SR006',
    name: 'CreateIndexBlocking',
    short: 'CREATE INDEX without CONCURRENTLY blocks writes',
    full: 'Building an index without CONCURRENTLY holds a SHARE lock that blocks all INSERT, UPDATE, and DELETE for the duration of the build.',
  },
  {
    id: 'SR007',
    name: 'AddForeignKey',
    short: 'ADD FOREIGN KEY acquires ShareRowExclusive lock',
    full: 'Adding a foreign key constraint validates the entire table and acquires a ShareRowExclusive lock. Validate the constraint with NOT VALID first.',
  },
  {
    id: 'SR008',
    name: 'DropIndex',
    short: 'DROP INDEX without CONCURRENTLY acquires ACCESS EXCLUSIVE lock',
    full: 'Dropping an index without CONCURRENTLY blocks all access to the table. Use DROP INDEX CONCURRENTLY instead.',
  },
  {
    id: 'SR009',
    name: 'RenameOperation',
    short: 'RENAME breaks all downstream code instantly',
    full: 'Renaming a table or column invalidates all queries, ORM models, views, and stored procedures referencing the old name.',
  },
  {
    id: 'SR010',
    name: 'TruncateTable',
    short: 'TRUNCATE permanently destroys all table data',
    full: 'TRUNCATE removes all rows from the table instantly. This operation is not easily reversible without a backup.',
  },
  {
    id: 'SR011',
    name: 'AddColumnDefaultOldPg',
    short: 'ADD COLUMN DEFAULT on PG ≤ 10 rewrites entire table',
    full: 'PostgreSQL 10 and below rewrites the entire table when adding a column with a DEFAULT value. This is metadata-only on PG 11+.',
  },
  {
    id: 'SR999',
    name: 'UnmodelledDDL',
    short: 'Unmodelled DDL — manual review required',
    full: 'This DDL statement was not fully analysed. It may acquire locks or modify data in unexpected ways.',
  },
];

function sarifLevel(risk: RiskLevel): string {
  switch (risk) {
    case RiskLevel.Critical:
    case RiskLevel.High:
      return 'error';
    case RiskLevel.Medium:
      return 'warning';
    case RiskLevel.Low:
      return 'note';
  }
}

export function renderSarif(reports: MigrationReport[]): string {
  const usedRuleIds = new Set<string>();
  for (const report of reports) {
    for (const op of report.operations) {
      usedRuleIds.add(op.ruleId);
    }
  }

  const rules = SARIF_RULES.filter((r) => usedRuleIds.has(r.id)).map((r) => ({
    id: r.id,
    name: r.name,
    shortDescription: { text: r.short },
    fullDescription: { text: r.full },
    defaultConfiguration: { level: 'error' },
    helpUri: 'https://github.com/Keystones-Lab/schema-risk-npm',
    help: { text: r.full },
  }));

  const results: Record<string, unknown>[] = [];
  for (const report of reports) {
    for (const op of report.operations) {
      if (op.score === 0 && op.riskLevel === RiskLevel.Low) continue;

      results.push({
        ruleId: op.ruleId,
        level: sarifLevel(op.riskLevel),
        message: { text: op.warning ?? op.description },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: report.file },
              region: { startLine: 1 },
            },
          },
        ],
        properties: {
          score: op.score,
          tables: op.tables,
          acquiresLock: op.acquiresLock,
          lockMode: op.lockMode,
        },
      });
    }
  }

  const sarif = {
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'SchemaRisk',
            version: '1.0.0',
            informationUri: 'https://github.com/Keystones-Lab/schema-risk-npm',
            rules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
