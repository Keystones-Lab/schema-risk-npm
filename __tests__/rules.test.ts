import { describe, it, expect } from 'vitest';
import { scoreDeltas, buildReport } from '../src/rules/index.js';
import type { SchemaDelta, ParsedStatement, DetectedOperation } from '../src/types.js';
import { RiskLevel } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDelta(
  overrides: Partial<SchemaDelta> & Pick<SchemaDelta, 'kind' | 'entityKey' | 'sourceStatement'>,
): SchemaDelta {
  return {
    entityType: 'table',
    cascadedRemovals: [],
    ...overrides,
  };
}

const defaultCtx = { pgVersion: 14, tableRows: {} as Record<string, number> };

// ─── scoreDeltas ─────────────────────────────────────────────────────────────

describe('scoreDeltas', () => {
  it('scores a DROP TABLE delta', () => {
    const stmt: ParsedStatement = {
      kind: 'DropTable',
      tables: ['users'],
      ifExists: false,
      cascade: false,
    };
    const delta = makeDelta({
      kind: 'remove',
      entityKey: 'table::users',
      entityType: 'table',
      sourceStatement: stmt,
      before: {
        type: 'table',
        name: 'users',
        qualifiedName: 'users',
        metadata: {},
        dependsOn: [],
      },
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR001');
    expect(ops[0].score).toBeGreaterThanOrEqual(100);
    expect(ops[0].acquiresLock).toBe(true);
    expect(ops[0].riskLevel).toBe(RiskLevel.High);
  });

  it('scores ALTER COLUMN TYPE', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableAlterColumnType',
      table: 'users',
      column: 'name',
      newType: 'TEXT',
    };
    const delta = makeDelta({
      kind: 'modify',
      entityKey: 'column::users.name',
      entityType: 'column',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR002');
    expect(ops[0].acquiresLock).toBe(true);
    expect(ops[0].indexRebuild).toBe(true);
  });

  it('scores DROP COLUMN', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableDropColumn',
      table: 'users',
      column: 'email',
      ifExists: false,
    };
    const delta = makeDelta({
      kind: 'remove',
      entityKey: 'column::users.email',
      entityType: 'column',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR003');
    expect(ops[0].score).toBeGreaterThanOrEqual(60);
  });

  it('scores SET NOT NULL', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableSetNotNull',
      table: 'users',
      column: 'email',
    };
    const delta = makeDelta({
      kind: 'modify',
      entityKey: 'column::users.email',
      entityType: 'column',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR004');
    expect(ops[0].riskLevel).toBe(RiskLevel.Medium);
  });

  it('scores ADD COLUMN NOT NULL without default', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableAddColumn',
      table: 'users',
      column: { name: 'status', dataType: 'TEXT', nullable: false, hasDefault: false, isPrimaryKey: false },
    };
    const delta = makeDelta({
      kind: 'add',
      entityKey: 'column::users.status',
      entityType: 'column',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR005');
  });

  it('scores safe ADD COLUMN (nullable)', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableAddColumn',
      table: 'users',
      column: { name: 'bio', dataType: 'TEXT', nullable: true, hasDefault: false, isPrimaryKey: false },
    };
    const delta = makeDelta({
      kind: 'add',
      entityKey: 'column::users.bio',
      entityType: 'column',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].riskLevel).toBe(RiskLevel.Low);
    expect(ops[0].score).toBeLessThanOrEqual(10);
  });

  it('scores CREATE INDEX without CONCURRENTLY', () => {
    const stmt: ParsedStatement = {
      kind: 'CreateIndex',
      indexName: 'idx_email',
      table: 'users',
      columns: ['email'],
      unique: false,
      concurrently: false,
    };
    const delta = makeDelta({
      kind: 'add',
      entityKey: 'index::idx_email',
      entityType: 'index',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR006');
    expect(ops[0].acquiresLock).toBe(true);
  });

  it('scores CREATE INDEX CONCURRENTLY as low risk', () => {
    const stmt: ParsedStatement = {
      kind: 'CreateIndex',
      indexName: 'idx_email',
      table: 'users',
      columns: ['email'],
      unique: false,
      concurrently: true,
    };
    const delta = makeDelta({
      kind: 'add',
      entityKey: 'index::idx_email',
      entityType: 'index',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].riskLevel).toBe(RiskLevel.Low);
    expect(ops[0].acquiresLock).toBe(false);
  });

  it('scores ADD FOREIGN KEY', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableAddForeignKey',
      table: 'orders',
      fk: {
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDeleteCascade: false,
        onUpdateCascade: false,
        constraintName: 'fk_user',
      },
    };
    const delta = makeDelta({
      kind: 'add',
      entityKey: 'constraint::fk_user',
      entityType: 'constraint',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR007');
    expect(ops[0].tables).toContain('orders');
    expect(ops[0].tables).toContain('users');
  });

  it('scores TRUNCATE', () => {
    const stmt: ParsedStatement = { kind: 'TruncateTable', tables: ['logs'] };
    const delta = makeDelta({
      kind: 'modify',
      entityKey: 'table::logs',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR010');
    expect(ops[0].riskLevel).toBe(RiskLevel.Critical);
    expect(ops[0].score).toBeGreaterThan(100);
  });

  it('scores RENAME COLUMN', () => {
    const stmt: ParsedStatement = {
      kind: 'AlterTableRenameColumn',
      table: 'users',
      oldName: 'email',
      newName: 'mail',
    };
    const delta = makeDelta({
      kind: 'modify',
      entityKey: 'column::users.email',
      entityType: 'column',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR009');
    expect(ops[0].riskLevel).toBe(RiskLevel.High);
  });

  it('scores CREATE TABLE as low risk', () => {
    const stmt: ParsedStatement = {
      kind: 'CreateTable',
      table: 'events',
      columns: [{ name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true }],
      foreignKeys: [],
      hasPrimaryKey: true,
    };
    const delta = makeDelta({
      kind: 'add',
      entityKey: 'table::events',
      sourceStatement: stmt,
    });
    const ops = scoreDeltas([delta], defaultCtx);
    expect(ops).toHaveLength(1);
    expect(ops[0].ruleId).toBe('SR000');
    expect(ops[0].riskLevel).toBe(RiskLevel.Low);
  });

  it('respects disabled rules', () => {
    const stmt: ParsedStatement = {
      kind: 'DropTable',
      tables: ['users'],
      ifExists: false,
      cascade: false,
    };
    const delta = makeDelta({
      kind: 'remove',
      entityKey: 'table::users',
      entityType: 'table',
      sourceStatement: stmt,
      before: { type: 'table', name: 'users', qualifiedName: 'users', metadata: {}, dependsOn: [] },
    });
    const ctx = {
      pgVersion: 14,
      tableRows: {},
      config: {
        version: 2,
        thresholds: { failOn: RiskLevel.High, guardOn: RiskLevel.Medium },
        rules: { disabled: ['SR001'], tableOverrides: {} },
        scan: { rootDir: '.', extensions: [], exclude: [] },
        output: { format: 'terminal' as const, color: true, showRecommendations: true },
      },
    };
    const ops = scoreDeltas([delta], ctx);
    expect(ops).toHaveLength(0);
  });
});

// ─── buildReport ─────────────────────────────────────────────────────────────

describe('buildReport', () => {
  it('aggregates operations into a MigrationReport', () => {
    const ops: DetectedOperation[] = [
      {
        ruleId: 'SR001',
        description: 'DROP TABLE users',
        tables: ['users'],
        riskLevel: RiskLevel.Critical,
        score: 100,
        warning: 'Dropping table is irreversible.',
        acquiresLock: true,
        lockMode: 'ACCESS EXCLUSIVE',
        indexRebuild: false,
        recommendation: 'Rename first.',
      },
      {
        ruleId: 'SR006',
        description: 'CREATE INDEX idx ON orders',
        tables: ['orders'],
        riskLevel: RiskLevel.Low,
        score: 20,
        acquiresLock: true,
        lockMode: 'SHARE',
        indexRebuild: false,
      },
    ];

    const report = buildReport('migration.sql', ops, 14);
    expect(report.file).toBe('migration.sql');
    expect(report.score).toBe(120);
    expect(report.overallRisk).toBe(RiskLevel.Critical);
    expect(report.affectedTables).toContain('users');
    expect(report.affectedTables).toContain('orders');
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
    expect(report.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(report.requiresMaintenanceWindow).toBe(true);
    expect(report.pgVersion).toBe(14);
    expect(report.analyzedAt).toBeDefined();
  });

  it('returns low risk report for safe operations', () => {
    const ops: DetectedOperation[] = [
      {
        ruleId: 'SR000',
        description: 'CREATE TABLE safe',
        tables: ['safe'],
        riskLevel: RiskLevel.Low,
        score: 5,
        acquiresLock: false,
        indexRebuild: false,
      },
    ];
    const report = buildReport('safe.sql', ops, 14);
    expect(report.score).toBe(5);
    expect(report.overallRisk).toBe(RiskLevel.Low);
    expect(report.requiresMaintenanceWindow).toBe(false);
  });
});
