// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Public Library API
// ─────────────────────────────────────────────────────────────────────────────

export {
  RiskLevel,
  riskLevelFromScore,
  riskGte,
  maxRisk,
  parseRiskLevel,
} from './types.js';

export type {
  SchemaEntity,
  SchemaEntityType,
  SchemaEntityMetadata,
  SchemaDelta,
  DeltaKind,
  ParsedStatement,
  ColumnInfo,
  ForeignKeyInfo,
  DetectedOperation,
  MigrationReport,
  DriftFinding,
  DriftReport,
  SchemaRiskConfig,
  AnalyzeOptions,
} from './types.js';

export { parseSQL } from './parser/index.js';
export { SchemaHashTable, SchemaSimulator, diffSchemas } from './engine/index.js';
export type { SimulationResult } from './engine/index.js';
export { scoreDeltas, buildReport } from './rules/index.js';
export type { RuleContext } from './rules/index.js';
export { loadConfig, getDefaultConfig, generateConfigFile } from './config/index.js';
export {
  formatReport,
  formatDriftReport,
  renderTerminal,
  renderSarif,
  renderJson,
  renderMarkdown,
} from './formatters/index.js';
export type { OutputFormat } from './formatters/index.js';

// ─── Convenience: full pipeline in one call ──────────────────────────────────

import { parseSQL } from './parser/index.js';
import { SchemaSimulator } from './engine/index.js';
import { scoreDeltas, buildReport } from './rules/index.js';
import type { MigrationReport, AnalyzeOptions } from './types.js';

export function analyze(
  file: string,
  sql: string,
  options: AnalyzeOptions = {},
): MigrationReport {
  const pgVersion = options.pgVersion ?? 14;
  const tableRows = options.tableRows ?? {};

  const statements = parseSQL(sql);
  const simulator = new SchemaSimulator(tableRows);
  const { deltas } = simulator.simulate(statements);

  const operations = scoreDeltas(deltas, {
    pgVersion,
    tableRows,
    config: options.config as import('./types.js').SchemaRiskConfig | undefined,
  });

  return buildReport(file, operations, pgVersion);
}
