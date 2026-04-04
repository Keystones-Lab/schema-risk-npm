// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

// ── Risk levels ──────────────────────────────────────────────────────────────

export enum RiskLevel {
  Low = 'LOW',
  Medium = 'MEDIUM',
  High = 'HIGH',
  Critical = 'CRITICAL',
}

const RISK_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.Low]: 0,
  [RiskLevel.Medium]: 1,
  [RiskLevel.High]: 2,
  [RiskLevel.Critical]: 3,
};

export function riskLevelFromScore(score: number): RiskLevel {
  if (score > 100) return RiskLevel.Critical;
  if (score > 50) return RiskLevel.High;
  if (score > 20) return RiskLevel.Medium;
  return RiskLevel.Low;
}

export function riskGte(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER[a] >= RISK_ORDER[b];
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function parseRiskLevel(s: string): RiskLevel {
  const upper = s.toUpperCase();
  if (upper === 'LOW') return RiskLevel.Low;
  if (upper === 'MEDIUM') return RiskLevel.Medium;
  if (upper === 'HIGH') return RiskLevel.High;
  if (upper === 'CRITICAL') return RiskLevel.Critical;
  return RiskLevel.High;
}

// ── Schema entity types (hash-table entries) ─────────────────────────────────

export type SchemaEntityType = 'table' | 'column' | 'index' | 'constraint';

export interface SchemaEntity {
  type: SchemaEntityType;
  name: string;
  qualifiedName: string;
  parent?: string;
  metadata: SchemaEntityMetadata;
  dependsOn: string[];
}

export interface SchemaEntityMetadata {
  dataType?: string;
  nullable?: boolean;
  hasDefault?: boolean;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  isConcurrent?: boolean;
  columns?: string[];
  refTable?: string;
  refColumns?: string[];
  onDeleteCascade?: boolean;
  onUpdateCascade?: boolean;
  estimatedRows?: number;
  [key: string]: unknown;
}

// ── Schema deltas (simulation output) ────────────────────────────────────────

export type DeltaKind = 'add' | 'modify' | 'remove';

export interface SchemaDelta {
  kind: DeltaKind;
  entityKey: string;
  entityType: SchemaEntityType;
  entity?: SchemaEntity;
  before?: SchemaEntity;
  after?: SchemaEntity;
  cascadedRemovals: string[];
  sourceStatement: ParsedStatement;
}

// ── Parsed SQL statements ────────────────────────────────────────────────────

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
}

export interface ForeignKeyInfo {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDeleteCascade: boolean;
  onUpdateCascade: boolean;
  constraintName?: string;
}

export type ParsedStatement =
  | {
      kind: 'CreateTable';
      table: string;
      columns: ColumnInfo[];
      foreignKeys: ForeignKeyInfo[];
      hasPrimaryKey: boolean;
    }
  | { kind: 'DropTable'; tables: string[]; ifExists: boolean; cascade: boolean }
  | { kind: 'AlterTableAddColumn'; table: string; column: ColumnInfo }
  | { kind: 'AlterTableDropColumn'; table: string; column: string; ifExists: boolean }
  | { kind: 'AlterTableAlterColumnType'; table: string; column: string; newType: string }
  | { kind: 'AlterTableSetNotNull'; table: string; column: string }
  | { kind: 'AlterTableDropNotNull'; table: string; column: string }
  | { kind: 'AlterTableAddForeignKey'; table: string; fk: ForeignKeyInfo }
  | {
      kind: 'AlterTableDropConstraint';
      table: string;
      constraint: string;
      cascade: boolean;
    }
  | { kind: 'AlterTableRenameColumn'; table: string; oldName: string; newName: string }
  | { kind: 'AlterTableRenameTable'; oldName: string; newName: string }
  | {
      kind: 'CreateIndex';
      indexName?: string;
      table: string;
      columns: string[];
      unique: boolean;
      concurrently: boolean;
    }
  | {
      kind: 'DropIndex';
      names: string[];
      concurrently: boolean;
      ifExists: boolean;
    }
  | { kind: 'AlterTableAddPrimaryKey'; table: string; columns: string[] }
  | { kind: 'AlterTableAlterColumnDefault'; table: string; column: string; dropDefault: boolean }
  | { kind: 'TruncateTable'; tables: string[] }
  | { kind: 'Other'; raw: string };

// ── Detected operations (risk analysis output) ──────────────────────────────

export interface DetectedOperation {
  ruleId: string;
  description: string;
  tables: string[];
  riskLevel: RiskLevel;
  score: number;
  warning?: string;
  acquiresLock: boolean;
  lockMode?: string;
  indexRebuild: boolean;
  recommendation?: string;
  fixedSql?: string;
  migrationSteps?: string[];
}

// ── Migration report ─────────────────────────────────────────────────────────

export interface MigrationReport {
  file: string;
  overallRisk: RiskLevel;
  score: number;
  affectedTables: string[];
  operations: DetectedOperation[];
  warnings: string[];
  recommendations: string[];
  estimatedLockSeconds?: number;
  indexRebuildRequired: boolean;
  requiresMaintenanceWindow: boolean;
  analyzedAt: string;
  pgVersion: number;
}

// ── Drift findings ───────────────────────────────────────────────────────────

export type DriftFindingKind =
  | 'extra_table'
  | 'missing_table'
  | 'column_type_mismatch'
  | 'extra_column'
  | 'missing_column'
  | 'extra_index'
  | 'missing_index'
  | 'nullable_mismatch';

export interface DriftFinding {
  kind: DriftFindingKind;
  severity: RiskLevel;
  table: string;
  column?: string;
  index?: string;
  expected?: string;
  actual?: string;
  description: string;
}

export interface DriftReport {
  overallDrift: RiskLevel;
  totalFindings: number;
  findings: DriftFinding[];
  beforeTables: string[];
  afterTables: string[];
  inSync: boolean;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface SchemaRiskConfig {
  version: number;
  thresholds: {
    failOn: RiskLevel;
    guardOn: RiskLevel;
  };
  rules: {
    disabled: string[];
    tableOverrides: Record<string, { maxRisk?: RiskLevel; ignored?: boolean }>;
  };
  scan: {
    rootDir: string;
    extensions: string[];
    exclude: string[];
  };
  output: {
    format: 'terminal' | 'json' | 'markdown' | 'sarif';
    color: boolean;
    showRecommendations: boolean;
  };
}

// ── Analysis options ─────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  pgVersion?: number;
  tableRows?: Record<string, number>;
  config?: Partial<SchemaRiskConfig>;
}
