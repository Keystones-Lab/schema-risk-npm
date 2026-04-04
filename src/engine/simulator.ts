// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Schema Simulator
//
// Processes ParsedStatement[] and applies each DDL mutation to the
// SchemaHashTable, recording a SchemaDelta for every change. The list of
// deltas is the simulation trace — the foundation for risk scoring.
// ─────────────────────────────────────────────────────────────────────────────

import { SchemaHashTable } from './schema-hash-table.js';
import type { ParsedStatement, SchemaDelta } from '../types.js';

export interface SimulationResult {
  deltas: SchemaDelta[];
  finalState: SchemaHashTable;
}

export class SchemaSimulator {
  private state: SchemaHashTable;
  private deltas: SchemaDelta[] = [];
  private tableRows: Record<string, number>;

  constructor(tableRows: Record<string, number> = {}) {
    this.state = new SchemaHashTable();
    this.tableRows = tableRows;
  }

  simulate(statements: ParsedStatement[]): SimulationResult {
    this.deltas = [];
    for (const stmt of statements) {
      this.apply(stmt);
    }
    return { deltas: [...this.deltas], finalState: this.state.clone() };
  }

  getState(): SchemaHashTable {
    return this.state;
  }

  // ─── Statement application ─────────────────────────────────────────────

  private apply(stmt: ParsedStatement): void {
    switch (stmt.kind) {
      case 'CreateTable':
        return this.applyCreateTable(stmt);
      case 'DropTable':
        return this.applyDropTable(stmt);
      case 'TruncateTable':
        return this.applyTruncate(stmt);
      case 'AlterTableAddColumn':
        return this.applyAddColumn(stmt);
      case 'AlterTableDropColumn':
        return this.applyDropColumn(stmt);
      case 'AlterTableAlterColumnType':
        return this.applyAlterColumnType(stmt);
      case 'AlterTableSetNotNull':
        return this.applySetNotNull(stmt);
      case 'AlterTableDropNotNull':
        return this.applyDropNotNull(stmt);
      case 'AlterTableAddForeignKey':
        return this.applyAddForeignKey(stmt);
      case 'AlterTableDropConstraint':
        return this.applyDropConstraint(stmt);
      case 'AlterTableRenameColumn':
        return this.applyRenameColumn(stmt);
      case 'AlterTableRenameTable':
        return this.applyRenameTable(stmt);
      case 'CreateIndex':
        return this.applyCreateIndex(stmt);
      case 'DropIndex':
        return this.applyDropIndex(stmt);
      case 'AlterTableAddPrimaryKey':
        return this.applyAddPrimaryKey(stmt);
      case 'AlterTableAlterColumnDefault':
        return this.applyAlterColumnDefault(stmt);
      case 'Other':
        // Record as a passthrough delta for belt-and-suspenders scoring
        this.deltas.push({
          kind: 'modify',
          entityKey: 'unknown',
          entityType: 'table',
          cascadedRemovals: [],
          sourceStatement: stmt,
        });
        return;
    }
  }

  // ─── CREATE TABLE ──────────────────────────────────────────────────────

  private applyCreateTable(
    stmt: Extract<ParsedStatement, { kind: 'CreateTable' }>,
  ): void {
    const rows = this.tableRows[stmt.table] ?? 0;
    this.state.addTable(stmt.table, { estimatedRows: rows });

    this.deltas.push({
      kind: 'add',
      entityKey: SchemaHashTable.tableKey(stmt.table),
      entityType: 'table',
      after: this.state.get(SchemaHashTable.tableKey(stmt.table)),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });

    for (const col of stmt.columns) {
      this.state.addColumn(stmt.table, col.name, {
        dataType: col.dataType,
        nullable: col.nullable,
        hasDefault: col.hasDefault,
        isPrimaryKey: col.isPrimaryKey,
      });
    }

    for (const fk of stmt.foreignKeys) {
      const constraintName =
        fk.constraintName ?? `fk_${stmt.table}_${fk.columns.join('_')}`;
      this.state.addConstraint(constraintName, stmt.table, {
        columns: fk.columns,
        refTable: fk.refTable,
        refColumns: fk.refColumns,
        onDeleteCascade: fk.onDeleteCascade,
        onUpdateCascade: fk.onUpdateCascade,
      });
    }
  }

  // ─── DROP TABLE ────────────────────────────────────────────────────────

  private applyDropTable(
    stmt: Extract<ParsedStatement, { kind: 'DropTable' }>,
  ): void {
    for (const table of stmt.tables) {
      const before = this.state.get(SchemaHashTable.tableKey(table));
      const refs = this.state.tablesReferencing(table);
      const cascaded = this.state.removeTable(table);

      this.deltas.push({
        kind: 'remove',
        entityKey: SchemaHashTable.tableKey(table),
        entityType: 'table',
        before: before
          ? {
              ...before,
              metadata: {
                ...before.metadata,
                referencedBy: refs,
              },
            }
          : undefined,
        cascadedRemovals: cascaded.filter(
          (k) => k !== SchemaHashTable.tableKey(table),
        ),
        sourceStatement: stmt,
      });
    }
  }

  // ─── TRUNCATE ──────────────────────────────────────────────────────────

  private applyTruncate(
    stmt: Extract<ParsedStatement, { kind: 'TruncateTable' }>,
  ): void {
    for (const table of stmt.tables) {
      const entity = this.state.get(SchemaHashTable.tableKey(table));
      // Truncate doesn't remove schema entities, but it destroys all data
      this.deltas.push({
        kind: 'modify',
        entityKey: SchemaHashTable.tableKey(table),
        entityType: 'table',
        entity,
        before: entity,
        after: entity,
        cascadedRemovals: [],
        sourceStatement: stmt,
      });
    }
  }

  // ─── ADD COLUMN ────────────────────────────────────────────────────────

  private applyAddColumn(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableAddColumn' }>,
  ): void {
    // Ensure parent table exists in hash table
    if (!this.state.hasTable(stmt.table)) {
      this.state.addTable(stmt.table, {
        estimatedRows: this.tableRows[stmt.table] ?? 0,
      });
    }

    this.state.addColumn(stmt.table, stmt.column.name, {
      dataType: stmt.column.dataType,
      nullable: stmt.column.nullable,
      hasDefault: stmt.column.hasDefault,
      isPrimaryKey: stmt.column.isPrimaryKey,
    });

    const key = SchemaHashTable.columnKey(stmt.table, stmt.column.name);
    this.deltas.push({
      kind: 'add',
      entityKey: key,
      entityType: 'column',
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── DROP COLUMN ───────────────────────────────────────────────────────

  private applyDropColumn(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableDropColumn' }>,
  ): void {
    const key = SchemaHashTable.columnKey(stmt.table, stmt.column);
    const before = this.state.get(key);
    const removed = this.state.removeColumn(stmt.table, stmt.column);

    this.deltas.push({
      kind: 'remove',
      entityKey: key,
      entityType: 'column',
      before,
      cascadedRemovals: removed.filter((k) => k !== key),
      sourceStatement: stmt,
    });
  }

  // ─── ALTER COLUMN TYPE ─────────────────────────────────────────────────

  private applyAlterColumnType(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableAlterColumnType' }>,
  ): void {
    const key = SchemaHashTable.columnKey(stmt.table, stmt.column);
    const before = this.state.get(key);

    this.state.modifyColumn(stmt.table, stmt.column, {
      dataType: stmt.newType,
    });

    this.deltas.push({
      kind: 'modify',
      entityKey: key,
      entityType: 'column',
      before,
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── SET NOT NULL ──────────────────────────────────────────────────────

  private applySetNotNull(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableSetNotNull' }>,
  ): void {
    const key = SchemaHashTable.columnKey(stmt.table, stmt.column);
    const before = this.state.get(key);

    this.state.modifyColumn(stmt.table, stmt.column, { nullable: false });

    this.deltas.push({
      kind: 'modify',
      entityKey: key,
      entityType: 'column',
      before,
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── DROP NOT NULL ─────────────────────────────────────────────────────

  private applyDropNotNull(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableDropNotNull' }>,
  ): void {
    const key = SchemaHashTable.columnKey(stmt.table, stmt.column);
    const before = this.state.get(key);

    this.state.modifyColumn(stmt.table, stmt.column, { nullable: true });

    this.deltas.push({
      kind: 'modify',
      entityKey: key,
      entityType: 'column',
      before,
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── ADD FOREIGN KEY ───────────────────────────────────────────────────

  private applyAddForeignKey(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableAddForeignKey' }>,
  ): void {
    const name =
      stmt.fk.constraintName ??
      `fk_${stmt.table}_${stmt.fk.columns.join('_')}`;

    this.state.addConstraint(name, stmt.table, {
      columns: stmt.fk.columns,
      refTable: stmt.fk.refTable,
      refColumns: stmt.fk.refColumns,
      onDeleteCascade: stmt.fk.onDeleteCascade,
      onUpdateCascade: stmt.fk.onUpdateCascade,
    });

    const key = SchemaHashTable.constraintKey(name);
    this.deltas.push({
      kind: 'add',
      entityKey: key,
      entityType: 'constraint',
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── DROP CONSTRAINT ───────────────────────────────────────────────────

  private applyDropConstraint(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableDropConstraint' }>,
  ): void {
    const key = SchemaHashTable.constraintKey(stmt.constraint);
    const before = this.state.get(key);
    this.state.removeConstraint(stmt.constraint);

    this.deltas.push({
      kind: 'remove',
      entityKey: key,
      entityType: 'constraint',
      before,
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── RENAME COLUMN ─────────────────────────────────────────────────────

  private applyRenameColumn(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableRenameColumn' }>,
  ): void {
    const oldKey = SchemaHashTable.columnKey(stmt.table, stmt.oldName);
    const before = this.state.get(oldKey);

    this.state.renameColumn(stmt.table, stmt.oldName, stmt.newName);

    const newKey = SchemaHashTable.columnKey(stmt.table, stmt.newName);
    this.deltas.push({
      kind: 'modify',
      entityKey: oldKey,
      entityType: 'column',
      before,
      after: this.state.get(newKey),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── RENAME TABLE ──────────────────────────────────────────────────────

  private applyRenameTable(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableRenameTable' }>,
  ): void {
    const oldKey = SchemaHashTable.tableKey(stmt.oldName);
    const before = this.state.get(oldKey);
    const result = this.state.renameTable(stmt.oldName, stmt.newName);

    this.deltas.push({
      kind: 'modify',
      entityKey: oldKey,
      entityType: 'table',
      before,
      after: this.state.get(SchemaHashTable.tableKey(stmt.newName)),
      cascadedRemovals: result?.removed.filter((k) => k !== oldKey) ?? [],
      sourceStatement: stmt,
    });
  }

  // ─── CREATE INDEX ──────────────────────────────────────────────────────

  private applyCreateIndex(
    stmt: Extract<ParsedStatement, { kind: 'CreateIndex' }>,
  ): void {
    // Ensure parent table exists
    if (!this.state.hasTable(stmt.table)) {
      this.state.addTable(stmt.table, {
        estimatedRows: this.tableRows[stmt.table] ?? 0,
      });
    }

    const name = stmt.indexName ?? `idx_${stmt.table}_${stmt.columns.join('_')}`;

    this.state.addIndex(name, stmt.table, {
      columns: stmt.columns,
      isUnique: stmt.unique,
      isConcurrent: stmt.concurrently,
    });

    const key = SchemaHashTable.indexKey(name);
    this.deltas.push({
      kind: 'add',
      entityKey: key,
      entityType: 'index',
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── DROP INDEX ────────────────────────────────────────────────────────

  private applyDropIndex(
    stmt: Extract<ParsedStatement, { kind: 'DropIndex' }>,
  ): void {
    for (const name of stmt.names) {
      const key = SchemaHashTable.indexKey(name);
      const before = this.state.get(key);
      this.state.removeIndex(name);

      this.deltas.push({
        kind: 'remove',
        entityKey: key,
        entityType: 'index',
        before,
        cascadedRemovals: [],
        sourceStatement: stmt,
      });
    }
  }

  // ─── ADD PRIMARY KEY ───────────────────────────────────────────────────

  private applyAddPrimaryKey(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableAddPrimaryKey' }>,
  ): void {
    const name = `pk_${stmt.table}`;
    this.state.addConstraint(name, stmt.table, {
      columns: stmt.columns,
      isPrimaryKey: true,
    });

    const key = SchemaHashTable.constraintKey(name);
    this.deltas.push({
      kind: 'add',
      entityKey: key,
      entityType: 'constraint',
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }

  // ─── ALTER COLUMN DEFAULT ──────────────────────────────────────────────

  private applyAlterColumnDefault(
    stmt: Extract<ParsedStatement, { kind: 'AlterTableAlterColumnDefault' }>,
  ): void {
    const key = SchemaHashTable.columnKey(stmt.table, stmt.column);
    const before = this.state.get(key);

    this.state.modifyColumn(stmt.table, stmt.column, {
      hasDefault: !stmt.dropDefault,
    });

    this.deltas.push({
      kind: 'modify',
      entityKey: key,
      entityType: 'column',
      before,
      after: this.state.get(key),
      cascadedRemovals: [],
      sourceStatement: stmt,
    });
  }
}
