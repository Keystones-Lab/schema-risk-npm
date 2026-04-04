// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Schema Differ
//
// Compares two SchemaHashTable snapshots to detect drift.
// Used when comparing migration-expected schema vs. a baseline.
// ─────────────────────────────────────────────────────────────────────────────

import { SchemaHashTable } from './schema-hash-table.js';
import { RiskLevel, maxRisk } from '../types.js';
import type { DriftFinding, DriftReport } from '../types.js';

export function diffSchemas(
  before: SchemaHashTable,
  after: SchemaHashTable,
): DriftReport {
  const findings: DriftFinding[] = [];

  const beforeTables = before.allTables();
  const afterTables = after.allTables();

  // Tables in "after" but not in "before" → extra table
  for (const table of afterTables) {
    if (!before.hasTable(table)) {
      findings.push({
        kind: 'extra_table',
        severity: RiskLevel.High,
        table,
        description: `Table '${table}' exists in the current state but not in the baseline`,
      });
    }
  }

  // Tables in "before" but not in "after" → missing table
  for (const table of beforeTables) {
    if (!after.hasTable(table)) {
      findings.push({
        kind: 'missing_table',
        severity: RiskLevel.Critical,
        table,
        description: `Table '${table}' is in the baseline but not in the current state`,
      });
    }
  }

  // For tables in both, compare columns and indexes
  for (const table of beforeTables) {
    if (!after.hasTable(table)) continue;

    const beforeCols = before.getTableColumns(table);
    const afterCols = after.getTableColumns(table);

    const beforeColMap = new Map(beforeCols.map((c) => [c.name.toLowerCase(), c]));
    const afterColMap = new Map(afterCols.map((c) => [c.name.toLowerCase(), c]));

    // Extra columns (in after, not in before)
    for (const [name, col] of afterColMap) {
      if (!beforeColMap.has(name)) {
        findings.push({
          kind: 'extra_column',
          severity: RiskLevel.Low,
          table,
          column: col.name,
          description: `Column '${table}.${col.name}' exists in current state but not in baseline`,
        });
      }
    }

    // Missing columns (in before, not in after)
    for (const [name, col] of beforeColMap) {
      if (!afterColMap.has(name)) {
        findings.push({
          kind: 'missing_column',
          severity: RiskLevel.High,
          table,
          column: col.name,
          description: `Column '${table}.${col.name}' is in baseline but not in current state`,
        });
      }
    }

    // Column comparisons (in both)
    for (const [name, beforeCol] of beforeColMap) {
      const afterCol = afterColMap.get(name);
      if (!afterCol) continue;

      // Type mismatch
      const beforeType = (beforeCol.metadata.dataType as string || '').toUpperCase();
      const afterType = (afterCol.metadata.dataType as string || '').toUpperCase();
      if (beforeType && afterType && beforeType !== afterType) {
        findings.push({
          kind: 'column_type_mismatch',
          severity: RiskLevel.Critical,
          table,
          column: beforeCol.name,
          expected: beforeType,
          actual: afterType,
          description: `Column '${table}.${beforeCol.name}': baseline says '${beforeType}' but current has '${afterType}'`,
        });
      }

      // Nullable mismatch
      if (
        beforeCol.metadata.nullable !== undefined &&
        afterCol.metadata.nullable !== undefined &&
        beforeCol.metadata.nullable !== afterCol.metadata.nullable
      ) {
        findings.push({
          kind: 'nullable_mismatch',
          severity: RiskLevel.Medium,
          table,
          column: beforeCol.name,
          expected: String(beforeCol.metadata.nullable),
          actual: String(afterCol.metadata.nullable),
          description: `Nullable mismatch on '${table}.${beforeCol.name}': baseline nullable=${beforeCol.metadata.nullable}, current nullable=${afterCol.metadata.nullable}`,
        });
      }
    }

    // Index comparison
    const beforeIdx = before.getTableIndexes(table);
    const afterIdx = after.getTableIndexes(table);
    const beforeIdxNames = new Set(beforeIdx.map((i) => i.name.toLowerCase()));
    const afterIdxNames = new Set(afterIdx.map((i) => i.name.toLowerCase()));

    for (const idx of afterIdx) {
      if (!beforeIdxNames.has(idx.name.toLowerCase())) {
        findings.push({
          kind: 'extra_index',
          severity: RiskLevel.Low,
          table,
          index: idx.name,
          description: `Index '${idx.name}' on '${table}' exists in current state but not in baseline`,
        });
      }
    }

    for (const idx of beforeIdx) {
      if (!afterIdxNames.has(idx.name.toLowerCase())) {
        findings.push({
          kind: 'missing_index',
          severity: RiskLevel.Medium,
          table,
          index: idx.name,
          description: `Index '${idx.name}' on '${table}' is in baseline but not in current state`,
        });
      }
    }
  }

  const overallDrift = findings.reduce<RiskLevel>(
    (acc, f) => maxRisk(acc, f.severity),
    RiskLevel.Low,
  );

  return {
    overallDrift: findings.length > 0 ? overallDrift : RiskLevel.Low,
    totalFindings: findings.length,
    findings,
    beforeTables,
    afterTables,
    inSync: findings.length === 0,
  };
}
