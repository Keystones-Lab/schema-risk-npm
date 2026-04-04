// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Schema Hash Table
//
// The core data structure: models the entire database schema as a
// Map<string, SchemaEntity>. Provides O(1) lookups, dependency tracking
// via a reverse-index, and efficient snapshot/diff operations.
//
// Key format:
//   table::users
//   column::users.email
//   index::idx_users_email
//   constraint::fk_orders_user
// ─────────────────────────────────────────────────────────────────────────────

import type { SchemaEntity, SchemaEntityMetadata } from '../types.js';

export class SchemaHashTable {
  /** Primary storage: entityKey → SchemaEntity */
  private entities: Map<string, SchemaEntity> = new Map();

  /** Reverse dependency index: entityKey → Set of keys that depend on it */
  private dependents: Map<string, Set<string>> = new Map();

  // ─── Key generation ────────────────────────────────────────────────────

  static tableKey(name: string): string {
    return `table::${name.toLowerCase()}`;
  }

  static columnKey(table: string, column: string): string {
    return `column::${table.toLowerCase()}.${column.toLowerCase()}`;
  }

  static indexKey(name: string): string {
    return `index::${name.toLowerCase()}`;
  }

  static constraintKey(name: string): string {
    return `constraint::${name.toLowerCase()}`;
  }

  // ─── Insertion ─────────────────────────────────────────────────────────

  addTable(name: string, metadata: SchemaEntityMetadata = {}): void {
    const key = SchemaHashTable.tableKey(name);
    if (this.entities.has(key)) return;
    this.entities.set(key, {
      type: 'table',
      name,
      qualifiedName: name,
      metadata,
      dependsOn: [],
    });
  }

  addColumn(
    table: string,
    name: string,
    metadata: SchemaEntityMetadata = {},
  ): void {
    const key = SchemaHashTable.columnKey(table, name);
    const parentKey = SchemaHashTable.tableKey(table);

    this.entities.set(key, {
      type: 'column',
      name,
      qualifiedName: `${table}.${name}`,
      parent: parentKey,
      metadata,
      dependsOn: [parentKey],
    });

    this.addDependent(parentKey, key);
  }

  addIndex(
    indexName: string,
    table: string,
    metadata: SchemaEntityMetadata = {},
  ): void {
    const key = SchemaHashTable.indexKey(indexName);
    const parentKey = SchemaHashTable.tableKey(table);

    this.entities.set(key, {
      type: 'index',
      name: indexName,
      qualifiedName: `${indexName}@${table}`,
      parent: parentKey,
      metadata,
      dependsOn: [parentKey],
    });

    this.addDependent(parentKey, key);
  }

  addConstraint(
    constraintName: string,
    table: string,
    metadata: SchemaEntityMetadata = {},
  ): void {
    const key = SchemaHashTable.constraintKey(constraintName);
    const parentKey = SchemaHashTable.tableKey(table);
    const dependsOn = [parentKey];

    // If FK references another table, add that as a dependency too
    if (metadata.refTable) {
      dependsOn.push(SchemaHashTable.tableKey(metadata.refTable as string));
    }

    this.entities.set(key, {
      type: 'constraint',
      name: constraintName,
      qualifiedName: `${constraintName}@${table}`,
      parent: parentKey,
      metadata,
      dependsOn,
    });

    for (const dep of dependsOn) {
      this.addDependent(dep, key);
    }
  }

  // ─── Removal (returns all cascaded removals) ──────────────────────────

  removeTable(name: string): string[] {
    const key = SchemaHashTable.tableKey(name);
    if (!this.entities.has(key)) return [];

    const removed: string[] = [];
    const deps = this.getDependentKeys(key);
    for (const depKey of deps) {
      this.entities.delete(depKey);
      this.dependents.delete(depKey);
      removed.push(depKey);
    }

    this.entities.delete(key);
    this.dependents.delete(key);
    removed.push(key);

    // Clean up reverse-index references
    for (const [, depSet] of this.dependents) {
      depSet.delete(key);
      for (const r of removed) depSet.delete(r);
    }

    return removed;
  }

  removeColumn(table: string, column: string): string[] {
    const key = SchemaHashTable.columnKey(table, column);
    if (!this.entities.has(key)) return [];

    const removed: string[] = [key];
    this.entities.delete(key);

    const parentKey = SchemaHashTable.tableKey(table);
    this.dependents.get(parentKey)?.delete(key);

    return removed;
  }

  removeIndex(name: string): string[] {
    const key = SchemaHashTable.indexKey(name);
    if (!this.entities.has(key)) return [];

    const entity = this.entities.get(key)!;
    this.entities.delete(key);

    if (entity.parent) {
      this.dependents.get(entity.parent)?.delete(key);
    }

    return [key];
  }

  removeConstraint(name: string): string[] {
    const key = SchemaHashTable.constraintKey(name);
    if (!this.entities.has(key)) return [];

    const entity = this.entities.get(key)!;
    this.entities.delete(key);

    for (const dep of entity.dependsOn) {
      this.dependents.get(dep)?.delete(key);
    }

    return [key];
  }

  // ─── Modification ──────────────────────────────────────────────────────

  modifyColumn(
    table: string,
    column: string,
    updates: Partial<SchemaEntityMetadata>,
  ): SchemaEntity | undefined {
    const key = SchemaHashTable.columnKey(table, column);
    const entity = this.entities.get(key);
    if (!entity) return undefined;

    const updated = {
      ...entity,
      metadata: { ...entity.metadata, ...updates },
    };
    this.entities.set(key, updated);
    return updated;
  }

  renameColumn(
    table: string,
    oldName: string,
    newName: string,
  ): { removed: string; added: string } | undefined {
    const oldKey = SchemaHashTable.columnKey(table, oldName);
    const entity = this.entities.get(oldKey);
    if (!entity) return undefined;

    const newKey = SchemaHashTable.columnKey(table, newName);
    const newEntity: SchemaEntity = {
      ...entity,
      name: newName,
      qualifiedName: `${table}.${newName}`,
    };

    this.entities.delete(oldKey);
    this.entities.set(newKey, newEntity);

    const parentKey = SchemaHashTable.tableKey(table);
    this.dependents.get(parentKey)?.delete(oldKey);
    this.addDependent(parentKey, newKey);

    return { removed: oldKey, added: newKey };
  }

  renameTable(
    oldName: string,
    newName: string,
  ): { removed: string[]; added: string[] } | undefined {
    const oldKey = SchemaHashTable.tableKey(oldName);
    const entity = this.entities.get(oldKey);
    if (!entity) return undefined;

    const removed: string[] = [oldKey];
    const added: string[] = [];

    // Create new table
    const newKey = SchemaHashTable.tableKey(newName);
    this.entities.set(newKey, {
      ...entity,
      name: newName,
      qualifiedName: newName,
    });
    added.push(newKey);
    this.entities.delete(oldKey);

    // Migrate all dependents
    const deps = this.getDependentKeys(oldKey);
    for (const depKey of deps) {
      const dep = this.entities.get(depKey);
      if (!dep) continue;

      removed.push(depKey);
      this.entities.delete(depKey);

      // Recreate with new parent
      const newDepKey = depKey.replace(
        oldName.toLowerCase(),
        newName.toLowerCase(),
      );
      this.entities.set(newDepKey, {
        ...dep,
        parent: newKey,
        qualifiedName: dep.qualifiedName.replace(oldName, newName),
        dependsOn: dep.dependsOn.map((d) => (d === oldKey ? newKey : d)),
      });
      added.push(newDepKey);
      this.addDependent(newKey, newDepKey);
    }

    this.dependents.delete(oldKey);

    return { removed, added };
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  has(key: string): boolean {
    return this.entities.has(key);
  }

  get(key: string): SchemaEntity | undefined {
    return this.entities.get(key);
  }

  hasTable(name: string): boolean {
    return this.entities.has(SchemaHashTable.tableKey(name));
  }

  hasColumn(table: string, column: string): boolean {
    return this.entities.has(SchemaHashTable.columnKey(table, column));
  }

  getTableColumns(table: string): SchemaEntity[] {
    const prefix = `column::${table.toLowerCase()}.`;
    const result: SchemaEntity[] = [];
    for (const [key, entity] of this.entities) {
      if (key.startsWith(prefix)) result.push(entity);
    }
    return result;
  }

  getTableIndexes(table: string): SchemaEntity[] {
    const tableKey = SchemaHashTable.tableKey(table);
    const result: SchemaEntity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'index' && entity.parent === tableKey) {
        result.push(entity);
      }
    }
    return result;
  }

  getDependentKeys(key: string): string[] {
    const deps = this.dependents.get(key);
    return deps ? [...deps] : [];
  }

  /** All tables that have a FK constraint pointing TO the given table */
  tablesReferencing(table: string): string[] {
    const tableKey = SchemaHashTable.tableKey(table);
    const result: string[] = [];
    for (const entity of this.entities.values()) {
      if (
        entity.type === 'constraint' &&
        entity.metadata.refTable &&
        SchemaHashTable.tableKey(entity.metadata.refTable as string) === tableKey
      ) {
        const parentTable = entity.parent;
        if (parentTable) {
          const tbl = this.entities.get(parentTable);
          if (tbl) result.push(tbl.name);
        }
      }
    }
    return [...new Set(result)];
  }

  allTables(): string[] {
    const tables: string[] = [];
    for (const [key, entity] of this.entities) {
      if (key.startsWith('table::')) tables.push(entity.name);
    }
    return tables.sort();
  }

  get size(): number {
    return this.entities.size;
  }

  // ─── Snapshot and cloning ──────────────────────────────────────────────

  snapshot(): Map<string, SchemaEntity> {
    const copy = new Map<string, SchemaEntity>();
    for (const [key, entity] of this.entities) {
      copy.set(key, {
        ...entity,
        metadata: { ...entity.metadata },
        dependsOn: [...entity.dependsOn],
      });
    }
    return copy;
  }

  clone(): SchemaHashTable {
    const ht = new SchemaHashTable();
    for (const [key, entity] of this.entities) {
      ht.entities.set(key, {
        ...entity,
        metadata: { ...entity.metadata },
        dependsOn: [...entity.dependsOn],
      });
    }
    for (const [key, deps] of this.dependents) {
      ht.dependents.set(key, new Set(deps));
    }
    return ht;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private addDependent(parentKey: string, childKey: string): void {
    let deps = this.dependents.get(parentKey);
    if (!deps) {
      deps = new Set();
      this.dependents.set(parentKey, deps);
    }
    deps.add(childKey);
  }
}
