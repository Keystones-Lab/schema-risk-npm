// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Risk Analysis Rules
//
// Each rule is a pure function that inspects a SchemaDelta (produced by the
// hash-table simulator) and returns DetectedOperation[] with risk scores.
// Rules are PG-version-aware and table-size-aware.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  SchemaDelta,
  DetectedOperation,
  MigrationReport,
  SchemaRiskConfig,
} from '../types.js';
import { RiskLevel, riskLevelFromScore, riskGte } from '../types.js';

export interface RuleContext {
  pgVersion: number;
  tableRows: Record<string, number>;
  config?: SchemaRiskConfig;
}

type RuleFn = (delta: SchemaDelta, ctx: RuleContext) => DetectedOperation | null;

// ─── Rule definitions ────────────────────────────────────────────────────────

function ruleDropTable(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'DropTable') return null;
  if (delta.kind !== 'remove' || delta.entityType !== 'table') return null;

  const table = delta.before?.name ?? 'unknown';
  const refs = (delta.before?.metadata.referencedBy as string[]) ?? [];
  const cascadeCount = delta.cascadedRemovals.length;

  let score = 100;
  score += refs.length * 20;
  score += cascadeCount * 5;

  return {
    ruleId: 'SR001',
    description: `DROP TABLE ${table}`,
    tables: [table],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: `Dropping '${table}' is irreversible.${refs.length > 0 ? ` Referenced by: ${refs.join(', ')}.` : ''}${cascadeCount > 0 ? ` ${cascadeCount} dependent entities will be destroyed.` : ''}`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Consider renaming the table first: ALTER TABLE ${table} RENAME TO ${table}_deprecated; then drop after a full release cycle.`,
  };
}

function ruleAlterColumnType(delta: SchemaDelta, ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableAlterColumnType') return null;

  const rows = ctx.tableRows[stmt.table] ?? 0;
  const score = rows > 1_000_000 ? 90 : 40;

  const rowNote = rows > 0 ? ` (~${rows.toLocaleString()} rows)` : '';

  return {
    ruleId: 'SR002',
    description: `ALTER TABLE ${stmt.table} ALTER COLUMN ${stmt.column} TYPE ${stmt.newType}${rowNote}`,
    tables: [stmt.table],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: `Type change on '${stmt.table}.${stmt.column}' → ${stmt.newType} requires a full table rewrite under ACCESS EXCLUSIVE lock${rowNote}.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: true,
    recommendation: `Use the 4-step zero-downtime pattern:\n  1. ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column}_v2 ${stmt.newType};\n  2. UPDATE ${stmt.table} SET ${stmt.column}_v2 = ${stmt.column}::${stmt.newType} WHERE ${stmt.column}_v2 IS NULL LIMIT 10000;\n  3. ALTER TABLE ${stmt.table} RENAME COLUMN ${stmt.column} TO ${stmt.column}_old;\n  4. ALTER TABLE ${stmt.table} RENAME COLUMN ${stmt.column}_v2 TO ${stmt.column};`,
    migrationSteps: [
      `ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column}_v2 ${stmt.newType};`,
      `UPDATE ${stmt.table} SET ${stmt.column}_v2 = ${stmt.column}::${stmt.newType} WHERE ${stmt.column}_v2 IS NULL LIMIT 10000;`,
      `ALTER TABLE ${stmt.table} RENAME COLUMN ${stmt.column} TO ${stmt.column}_old;`,
      `ALTER TABLE ${stmt.table} RENAME COLUMN ${stmt.column}_v2 TO ${stmt.column};`,
      `ALTER TABLE ${stmt.table} DROP COLUMN ${stmt.column}_old;`,
    ],
  };
}

function ruleDropColumn(delta: SchemaDelta, ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableDropColumn') return null;

  const rows = ctx.tableRows[stmt.table] ?? 0;
  const score = rows > 1_000_000 ? 80 : 60;

  return {
    ruleId: 'SR003',
    description: `ALTER TABLE ${stmt.table} DROP COLUMN ${stmt.column}`,
    tables: [stmt.table],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: `Dropping column '${stmt.table}.${stmt.column}' is irreversible and may break application code.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Deploy app changes to stop reading '${stmt.column}' first, then drop the column in a follow-up migration.`,
  };
}

function ruleSetNotNull(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableSetNotNull') return null;

  return {
    ruleId: 'SR004',
    description: `ALTER TABLE ${stmt.table} ALTER COLUMN ${stmt.column} SET NOT NULL`,
    tables: [stmt.table],
    riskLevel: RiskLevel.Medium,
    score: 35,
    warning: `SET NOT NULL requires a full table scan to validate existing rows.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Use a CHECK constraint with NOT VALID first:\n  ALTER TABLE ${stmt.table} ADD CONSTRAINT ${stmt.column}_not_null CHECK (${stmt.column} IS NOT NULL) NOT VALID;\n  ALTER TABLE ${stmt.table} VALIDATE CONSTRAINT ${stmt.column}_not_null;`,
  };
}

function ruleAddColumnNotNull(delta: SchemaDelta, ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableAddColumn') return null;
  if (stmt.column.nullable || stmt.column.hasDefault) return null;

  const rows = ctx.tableRows[stmt.table] ?? 0;
  const score = rows > 0 ? 50 : 25;

  return {
    ruleId: 'SR005',
    description: `ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column.name} ${stmt.column.dataType} NOT NULL (no default)`,
    tables: [stmt.table],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: `Adding NOT NULL column '${stmt.table}.${stmt.column.name}' without a DEFAULT will fail if the table has existing rows.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Add with a DEFAULT value:\n  ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column.name} ${stmt.column.dataType} NOT NULL DEFAULT <value>;`,
  };
}

function ruleCreateIndexBlocking(delta: SchemaDelta, ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'CreateIndex') return null;
  if (stmt.concurrently) {
    // Concurrent index is safe — emit low-risk
    return {
      ruleId: 'SR006',
      description: `CREATE INDEX CONCURRENTLY ${stmt.indexName ?? ''} ON ${stmt.table}(${stmt.columns.join(', ')})`,
      tables: [stmt.table],
      riskLevel: RiskLevel.Low,
      score: 5,
      acquiresLock: false,
      indexRebuild: false,
    };
  }

  const rows = ctx.tableRows[stmt.table] ?? 0;
  const score = rows > 1_000_000 ? 70 : 20;
  const name = stmt.indexName ?? 'unnamed';
  const unique = stmt.unique ? 'UNIQUE ' : '';

  return {
    ruleId: 'SR006',
    description: `CREATE ${unique}INDEX ${name} ON ${stmt.table}(${stmt.columns.join(', ')})`,
    tables: [stmt.table],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: `CREATE INDEX on '${stmt.table}' without CONCURRENTLY will hold a SHARE lock for the duration of the build (cols: ${stmt.columns.join(', ')}).`,
    acquiresLock: true,
    lockMode: 'SHARE',
    indexRebuild: false,
    recommendation: `Use CONCURRENTLY:\n  CREATE ${unique}INDEX CONCURRENTLY ${name} ON ${stmt.table}(${stmt.columns.join(', ')});`,
    fixedSql: `CREATE ${unique}INDEX CONCURRENTLY ${name} ON ${stmt.table}(${stmt.columns.join(', ')});`,
  };
}

function ruleAddForeignKey(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableAddForeignKey') return null;

  return {
    ruleId: 'SR007',
    description: `ALTER TABLE ${stmt.table} ADD FOREIGN KEY (${stmt.fk.columns.join(', ')}) REFERENCES ${stmt.fk.refTable}`,
    tables: [stmt.table, stmt.fk.refTable],
    riskLevel: RiskLevel.Medium,
    score: 30,
    warning: `Adding a foreign key validates the entire table and acquires a ShareRowExclusive lock.`,
    acquiresLock: true,
    lockMode: 'SHARE ROW EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Validate with NOT VALID first:\n  ALTER TABLE ${stmt.table} ADD CONSTRAINT ${stmt.fk.constraintName ?? `fk_${stmt.table}`} FOREIGN KEY (${stmt.fk.columns.join(', ')}) REFERENCES ${stmt.fk.refTable}(${stmt.fk.refColumns.join(', ')}) NOT VALID;\n  ALTER TABLE ${stmt.table} VALIDATE CONSTRAINT ${stmt.fk.constraintName ?? `fk_${stmt.table}`};`,
  };
}

function ruleDropIndex(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'DropIndex') return null;

  const score = stmt.concurrently ? 5 : 15;
  return {
    ruleId: 'SR008',
    description: `DROP INDEX${stmt.concurrently ? ' CONCURRENTLY' : ''} ${stmt.names.join(', ')}`,
    tables: [],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: stmt.concurrently
      ? undefined
      : `DROP INDEX without CONCURRENTLY acquires an ACCESS EXCLUSIVE lock.`,
    acquiresLock: !stmt.concurrently,
    lockMode: stmt.concurrently ? undefined : 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: stmt.concurrently
      ? undefined
      : `Use: DROP INDEX CONCURRENTLY ${stmt.names.join(', ')};`,
  };
}

function ruleRenameColumn(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableRenameColumn') return null;

  return {
    ruleId: 'SR009',
    description: `ALTER TABLE ${stmt.table} RENAME COLUMN ${stmt.oldName} TO ${stmt.newName}`,
    tables: [stmt.table],
    riskLevel: RiskLevel.High,
    score: 55,
    warning: `Renaming '${stmt.table}.${stmt.oldName}' → '${stmt.newName}' breaks all downstream code, ORM models, views, and stored procedures.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Add a new column, backfill, deploy app to use new name, then drop old column.`,
  };
}

function ruleRenameTable(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableRenameTable') return null;

  return {
    ruleId: 'SR009',
    description: `ALTER TABLE ${stmt.oldName} RENAME TO ${stmt.newName}`,
    tables: [stmt.oldName],
    riskLevel: RiskLevel.High,
    score: 60,
    warning: `Renaming table '${stmt.oldName}' → '${stmt.newName}' breaks all downstream code instantly.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Create the new table, copy data, and swap access at the application layer.`,
  };
}

function ruleTruncate(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'TruncateTable') return null;

  return {
    ruleId: 'SR010',
    description: `TRUNCATE TABLE ${stmt.tables.join(', ')}`,
    tables: [...stmt.tables],
    riskLevel: RiskLevel.Critical,
    score: 110,
    warning: `TRUNCATE permanently destroys all data in ${stmt.tables.join(', ')}.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Ensure you have a backup before truncating. Consider DELETE with a WHERE clause for partial removal.`,
  };
}

function ruleAddColumnDefaultOldPg(
  delta: SchemaDelta,
  ctx: RuleContext,
): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableAddColumn') return null;
  if (!stmt.column.hasDefault) return null;
  if (ctx.pgVersion >= 11) return null; // PG11+ is metadata-only

  const rows = ctx.tableRows[stmt.table] ?? 0;
  const score = rows > 1_000_000 ? 80 : 45;
  const rowNote = rows > 0 ? ` (~${rows.toLocaleString()} rows)` : '';

  return {
    ruleId: 'SR011',
    description: `ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column.name} ${stmt.column.dataType} WITH DEFAULT (PG${ctx.pgVersion} — table rewrite${rowNote})`,
    tables: [stmt.table],
    riskLevel: riskLevelFromScore(score),
    score,
    warning: `PostgreSQL ${ctx.pgVersion} rewrites the ENTIRE table when adding a column with a DEFAULT value${rowNote}. Upgrade to PG11+ where this is a metadata-only operation.`,
    acquiresLock: true,
    lockMode: 'ACCESS EXCLUSIVE',
    indexRebuild: false,
    recommendation: `Upgrade to PostgreSQL 11+ or add the column without a default, then backfill in batches.`,
  };
}

function ruleAddColumnSafe(delta: SchemaDelta, ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'AlterTableAddColumn') return null;
  // Only emit for safe add-column (nullable or has-default on PG11+)
  if (!stmt.column.nullable && !stmt.column.hasDefault) return null;
  if (stmt.column.hasDefault && ctx.pgVersion < 11) return null;

  const pgNote = stmt.column.hasDefault ? ` (metadata-only on PG${ctx.pgVersion})` : '';

  return {
    ruleId: 'SR005',
    description: `ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column.name} ${stmt.column.dataType}${pgNote}`,
    tables: [stmt.table],
    riskLevel: RiskLevel.Low,
    score: 5,
    acquiresLock: false,
    indexRebuild: false,
  };
}

function ruleCreateTable(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'CreateTable') return null;

  return {
    ruleId: 'SR000',
    description: `CREATE TABLE ${stmt.table}`,
    tables: [stmt.table],
    riskLevel: RiskLevel.Low,
    score: 5,
    acquiresLock: false,
    indexRebuild: false,
  };
}

function ruleOther(delta: SchemaDelta, _ctx: RuleContext): DetectedOperation | null {
  const stmt = delta.sourceStatement;
  if (stmt.kind !== 'Other') return null;

  const hasUnsafe = /DROP TABLE|DROP DATABASE|DROP SCHEMA|TRUNCATE|ALTER TABLE/i.test(stmt.raw);
  if (!hasUnsafe) return null;

  return {
    ruleId: 'SR999',
    description: `Unmodelled DDL — manual review required`,
    tables: [],
    riskLevel: RiskLevel.Medium,
    score: 25,
    warning: `Unmodelled DDL detected: ${stmt.raw.slice(0, 80)}. This may acquire locks or modify data.`,
    acquiresLock: true,
    indexRebuild: false,
  };
}

// ─── Rule registry ───────────────────────────────────────────────────────────

const ALL_RULES: RuleFn[] = [
  ruleDropTable,
  ruleAlterColumnType,
  ruleDropColumn,
  ruleSetNotNull,
  ruleAddColumnNotNull,
  ruleAddColumnDefaultOldPg,
  ruleAddColumnSafe,
  ruleCreateIndexBlocking,
  ruleAddForeignKey,
  ruleDropIndex,
  ruleRenameColumn,
  ruleRenameTable,
  ruleTruncate,
  ruleCreateTable,
  ruleOther,
];

// ─── Public API: score all deltas and build a MigrationReport ────────────────

export function scoreDeltas(
  deltas: SchemaDelta[],
  ctx: RuleContext,
): DetectedOperation[] {
  const ops: DetectedOperation[] = [];
  const disabled = new Set(ctx.config?.rules.disabled ?? []);

  for (const delta of deltas) {
    for (const rule of ALL_RULES) {
      const op = rule(delta, ctx);
      if (op && !disabled.has(op.ruleId)) {
        ops.push(op);
        break; // first matching rule wins per delta
      }
    }
  }

  return ops;
}

export function buildReport(
  file: string,
  operations: DetectedOperation[],
  pgVersion: number,
): MigrationReport {
  const score = operations.reduce((acc, op) => acc + op.score, 0);
  const overallRisk = riskLevelFromScore(score);

  const affectedTables = [
    ...new Set(operations.flatMap((op) => op.tables)),
  ].sort();

  const warnings = dedupePreserveOrder(
    operations.filter((op) => op.warning).map((op) => op.warning!),
  );

  const recommendations = dedupePreserveOrder(
    operations.filter((op) => op.recommendation).map((op) => op.recommendation!),
  );

  const indexRebuildRequired = operations.some((op) => op.indexRebuild);
  const requiresMaintenanceWindow = riskGte(overallRisk, RiskLevel.High);

  const estimatedLockSeconds = estimateLockDuration(operations);

  return {
    file,
    overallRisk,
    score,
    affectedTables,
    operations,
    warnings,
    recommendations,
    estimatedLockSeconds,
    indexRebuildRequired,
    requiresMaintenanceWindow,
    analyzedAt: new Date().toISOString(),
    pgVersion,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function estimateLockDuration(ops: DetectedOperation[]): number | undefined {
  const lockOps = ops.filter((op) => op.acquiresLock);
  if (lockOps.length === 0) return undefined;

  let totalSecs = 0;
  for (const op of lockOps) {
    if (op.lockMode === 'ACCESS EXCLUSIVE') {
      totalSecs += op.score >= 80 ? 90 : op.score >= 40 ? 30 : 5;
    } else if (op.lockMode === 'SHARE') {
      totalSecs += op.score >= 50 ? 60 : 10;
    } else {
      totalSecs += 5;
    }
  }
  return totalSecs;
}
