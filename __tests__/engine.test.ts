import { describe, it, expect } from 'vitest';
import { SchemaHashTable, SchemaSimulator, diffSchemas } from '../src/engine/index.js';
import type { ParsedStatement } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// SchemaHashTable
// ─────────────────────────────────────────────────────────────────────────────

describe('SchemaHashTable', () => {
  it('starts empty', () => {
    const ht = new SchemaHashTable();
    expect(ht.size).toBe(0);
    expect(ht.allTables()).toHaveLength(0);
  });

  it('adds and queries a table', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    expect(ht.hasTable('users')).toBe(true);
    expect(ht.allTables()).toContain('users');
    expect(ht.size).toBe(1);
  });

  it('adds columns to a table', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addColumn('users', 'email', { dataType: 'TEXT', nullable: true });
    expect(ht.hasColumn('users', 'email')).toBe(true);
    const cols = ht.getTableColumns('users');
    expect(cols).toHaveLength(1);
    expect(cols[0].name).toBe('email');
    expect(cols[0].metadata.dataType).toBe('TEXT');
  });

  it('adds an index', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addIndex('idx_email', 'users', { columns: ['email'] });
    const idxs = ht.getTableIndexes('users');
    expect(idxs).toHaveLength(1);
    expect(idxs[0].name).toBe('idx_email');
  });

  it('adds a constraint with FK dependency tracking', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addTable('orders');
    ht.addConstraint('fk_orders_user', 'orders', { refTable: 'users' });
    const refs = ht.tablesReferencing('users');
    expect(refs).toContain('orders');
  });

  it('removes a table with cascading', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addColumn('users', 'id', { dataType: 'INT' });
    ht.addColumn('users', 'email', { dataType: 'TEXT' });
    ht.addIndex('idx_email', 'users', { columns: ['email'] });

    const removed = ht.removeTable('users');
    expect(removed.length).toBeGreaterThanOrEqual(3); // 2 cols + 1 idx + table
    expect(ht.hasTable('users')).toBe(false);
    expect(ht.hasColumn('users', 'email')).toBe(false);
  });

  it('renames a column', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addColumn('users', 'email', { dataType: 'TEXT' });
    ht.renameColumn('users', 'email', 'email_address');
    expect(ht.hasColumn('users', 'email')).toBe(false);
    expect(ht.hasColumn('users', 'email_address')).toBe(true);
  });

  it('renames a table and migrates dependents', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addColumn('users', 'id', { dataType: 'INT' });
    const result = ht.renameTable('users', 'customers');
    expect(result).toBeDefined();
    expect(ht.hasTable('users')).toBe(false);
    expect(ht.hasTable('customers')).toBe(true);
    expect(ht.hasColumn('customers', 'id')).toBe(true);
  });

  it('clones without sharing state', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    const clone = ht.clone();
    clone.addTable('orders');
    expect(ht.hasTable('orders')).toBe(false);
    expect(clone.hasTable('orders')).toBe(true);
  });

  it('modifies column metadata', () => {
    const ht = new SchemaHashTable();
    ht.addTable('users');
    ht.addColumn('users', 'email', { dataType: 'TEXT', nullable: true });
    ht.modifyColumn('users', 'email', { nullable: false });
    const key = SchemaHashTable.columnKey('users', 'email');
    const entity = ht.get(key);
    expect(entity?.metadata.nullable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SchemaSimulator
// ─────────────────────────────────────────────────────────────────────────────

describe('SchemaSimulator', () => {
  it('simulates CREATE TABLE', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [
          { name: 'id', dataType: 'SERIAL', nullable: false, hasDefault: false, isPrimaryKey: true },
          { name: 'email', dataType: 'TEXT', nullable: true, hasDefault: false, isPrimaryKey: false },
        ],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0].kind).toBe('add');
    expect(deltas[0].entityType).toBe('table');
    expect(finalState.hasTable('users')).toBe(true);
    expect(finalState.hasColumn('users', 'id')).toBe(true);
    expect(finalState.hasColumn('users', 'email')).toBe(true);
  });

  it('simulates DROP TABLE', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'temp',
        columns: [{ name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true }],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      { kind: 'DropTable', tables: ['temp'], ifExists: false, cascade: false },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(deltas[1].kind).toBe('remove');
    expect(deltas[1].entityType).toBe('table');
    expect(finalState.hasTable('temp')).toBe(false);
  });

  it('simulates ALTER TABLE ADD COLUMN', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [{ name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true }],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      {
        kind: 'AlterTableAddColumn',
        table: 'users',
        column: { name: 'age', dataType: 'INTEGER', nullable: true, hasDefault: false, isPrimaryKey: false },
      },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(deltas[1].kind).toBe('add');
    expect(deltas[1].entityType).toBe('column');
    expect(finalState.hasColumn('users', 'age')).toBe(true);
  });

  it('simulates ALTER TABLE DROP COLUMN', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [
          { name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true },
          { name: 'email', dataType: 'TEXT', nullable: true, hasDefault: false, isPrimaryKey: false },
        ],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      { kind: 'AlterTableDropColumn', table: 'users', column: 'email', ifExists: false },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(deltas[1].kind).toBe('remove');
    expect(deltas[1].entityType).toBe('column');
    expect(finalState.hasColumn('users', 'email')).toBe(false);
  });

  it('simulates ALTER COLUMN TYPE', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [
          { name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true },
          { name: 'name', dataType: 'VARCHAR(50)', nullable: true, hasDefault: false, isPrimaryKey: false },
        ],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      { kind: 'AlterTableAlterColumnType', table: 'users', column: 'name', newType: 'TEXT' },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(deltas[1].kind).toBe('modify');
    const key = SchemaHashTable.columnKey('users', 'name');
    const col = finalState.get(key);
    expect(col?.metadata.dataType).toBe('TEXT');
  });

  it('simulates CREATE and DROP INDEX', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [{ name: 'email', dataType: 'TEXT', nullable: true, hasDefault: false, isPrimaryKey: false }],
        foreignKeys: [],
        hasPrimaryKey: false,
      },
      { kind: 'CreateIndex', indexName: 'idx_email', table: 'users', columns: ['email'], unique: false, concurrently: false },
      { kind: 'DropIndex', names: ['idx_email'], concurrently: false, ifExists: false },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(3);
    expect(deltas[1].kind).toBe('add');
    expect(deltas[1].entityType).toBe('index');
    expect(deltas[2].kind).toBe('remove');
    expect(deltas[2].entityType).toBe('index');
    expect(finalState.getTableIndexes('users')).toHaveLength(0);
  });

  it('simulates RENAME TABLE', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [{ name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true }],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      { kind: 'AlterTableRenameTable', oldName: 'users', newName: 'customers' },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(finalState.hasTable('users')).toBe(false);
    expect(finalState.hasTable('customers')).toBe(true);
  });

  it('simulates TRUNCATE', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'logs',
        columns: [{ name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true }],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      { kind: 'TruncateTable', tables: ['logs'] },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(deltas[1].kind).toBe('modify');
    // Truncate doesn't remove the table
    expect(finalState.hasTable('logs')).toBe(true);
  });

  it('simulates SET NOT NULL', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [
      {
        kind: 'CreateTable',
        table: 'users',
        columns: [
          { name: 'id', dataType: 'INT', nullable: false, hasDefault: false, isPrimaryKey: true },
          { name: 'email', dataType: 'TEXT', nullable: true, hasDefault: false, isPrimaryKey: false },
        ],
        foreignKeys: [],
        hasPrimaryKey: true,
      },
      { kind: 'AlterTableSetNotNull', table: 'users', column: 'email' },
    ];
    const { deltas, finalState } = sim.simulate(stmts);
    expect(deltas).toHaveLength(2);
    expect(deltas[1].kind).toBe('modify');
    const key = SchemaHashTable.columnKey('users', 'email');
    expect(finalState.get(key)?.metadata.nullable).toBe(false);
  });

  it('simulates Other statement', () => {
    const sim = new SchemaSimulator();
    const stmts: ParsedStatement[] = [{ kind: 'Other', raw: 'SELECT 1' }];
    const { deltas } = sim.simulate(stmts);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].entityKey).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diffSchemas
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSchemas', () => {
  it('reports inSync when schemas match', () => {
    const a = new SchemaHashTable();
    a.addTable('users');
    a.addColumn('users', 'id', { dataType: 'INT' });

    const b = new SchemaHashTable();
    b.addTable('users');
    b.addColumn('users', 'id', { dataType: 'INT' });

    const drift = diffSchemas(a, b);
    expect(drift.inSync).toBe(true);
    expect(drift.totalFindings).toBe(0);
    expect(drift.findings).toHaveLength(0);
  });

  it('detects extra table in after', () => {
    const before = new SchemaHashTable();
    const after = new SchemaHashTable();
    after.addTable('orders');

    const drift = diffSchemas(before, after);
    expect(drift.inSync).toBe(false);
    expect(drift.findings.some((f) => f.kind === 'extra_table' && f.table === 'orders')).toBe(true);
  });

  it('detects missing table', () => {
    const before = new SchemaHashTable();
    before.addTable('users');
    const after = new SchemaHashTable();

    const drift = diffSchemas(before, after);
    expect(drift.inSync).toBe(false);
    expect(drift.findings.some((f) => f.kind === 'missing_table' && f.table === 'users')).toBe(true);
  });

  it('detects column type mismatch', () => {
    const before = new SchemaHashTable();
    before.addTable('users');
    before.addColumn('users', 'name', { dataType: 'VARCHAR(50)' });

    const after = new SchemaHashTable();
    after.addTable('users');
    after.addColumn('users', 'name', { dataType: 'TEXT' });

    const drift = diffSchemas(before, after);
    expect(drift.inSync).toBe(false);
    expect(drift.findings.some((f) => f.kind === 'column_type_mismatch')).toBe(true);
  });

  it('detects nullable mismatch', () => {
    const before = new SchemaHashTable();
    before.addTable('users');
    before.addColumn('users', 'email', { dataType: 'TEXT', nullable: true });

    const after = new SchemaHashTable();
    after.addTable('users');
    after.addColumn('users', 'email', { dataType: 'TEXT', nullable: false });

    const drift = diffSchemas(before, after);
    expect(drift.inSync).toBe(false);
    expect(drift.findings.some((f) => f.kind === 'nullable_mismatch')).toBe(true);
  });

  it('detects extra and missing columns', () => {
    const before = new SchemaHashTable();
    before.addTable('users');
    before.addColumn('users', 'id', { dataType: 'INT' });

    const after = new SchemaHashTable();
    after.addTable('users');
    after.addColumn('users', 'name', { dataType: 'TEXT' });

    const drift = diffSchemas(before, after);
    expect(drift.inSync).toBe(false);
    expect(drift.findings.some((f) => f.kind === 'extra_column' && f.column === 'name')).toBe(true);
    expect(drift.findings.some((f) => f.kind === 'missing_column' && f.column === 'id')).toBe(true);
  });

  it('detects extra and missing indexes', () => {
    const before = new SchemaHashTable();
    before.addTable('users');
    before.addIndex('idx_a', 'users', { columns: ['a'] });

    const after = new SchemaHashTable();
    after.addTable('users');
    after.addIndex('idx_b', 'users', { columns: ['b'] });

    const drift = diffSchemas(before, after);
    expect(drift.findings.some((f) => f.kind === 'extra_index')).toBe(true);
    expect(drift.findings.some((f) => f.kind === 'missing_index')).toBe(true);
  });

  it('provides overall drift severity', () => {
    const before = new SchemaHashTable();
    before.addTable('users');
    const after = new SchemaHashTable();

    const drift = diffSchemas(before, after);
    expect(drift.overallDrift).toBeDefined();
    expect(drift.beforeTables).toContain('users');
    expect(drift.afterTables).toHaveLength(0);
  });
});
