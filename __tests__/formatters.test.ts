import { describe, it, expect } from 'vitest';
import { formatReport, formatDriftReport, type OutputFormat } from '../src/formatters/index.js';
import { RiskLevel } from '../src/types.js';
import type { MigrationReport, DriftReport } from '../src/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sampleReport: MigrationReport = {
  file: 'migration.sql',
  overallRisk: RiskLevel.Critical,
  score: 120,
  affectedTables: ['users', 'orders'],
  operations: [
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
      recommendation: 'Rename the table first.',
    },
    {
      ruleId: 'SR006',
      description: 'CREATE INDEX idx ON orders(email)',
      tables: ['orders'],
      riskLevel: RiskLevel.Low,
      score: 20,
      acquiresLock: true,
      lockMode: 'SHARE',
      indexRebuild: false,
    },
  ],
  warnings: ['Dropping table is irreversible.'],
  recommendations: ['Rename the table first.'],
  estimatedLockSeconds: 90,
  indexRebuildRequired: false,
  requiresMaintenanceWindow: true,
  analyzedAt: '2025-01-01T00:00:00.000Z',
  pgVersion: 14,
};

const sampleDriftReport: DriftReport = {
  overallDrift: RiskLevel.High,
  totalFindings: 2,
  findings: [
    {
      kind: 'extra_table',
      severity: RiskLevel.High,
      table: 'temp',
      description: "Table 'temp' exists in current state but not in baseline",
    },
    {
      kind: 'missing_column',
      severity: RiskLevel.High,
      table: 'users',
      column: 'email',
      description: "Column 'users.email' is in baseline but not in current state",
    },
  ],
  beforeTables: ['users'],
  afterTables: ['users', 'temp'],
  inSync: false,
};

// ─── formatReport ────────────────────────────────────────────────────────────

describe('formatReport', () => {
  it('formats as terminal', () => {
    const output = formatReport([sampleReport], 'terminal');
    expect(output).toContain('migration.sql');
    expect(output).toContain('CRITICAL');
  });

  it('formats as JSON', () => {
    const output = formatReport([sampleReport], 'json');
    const parsed = JSON.parse(output);
    // Single report returns an object, not an array
    expect(parsed.file).toBe('migration.sql');
    expect(parsed.score).toBe(120);
  });

  it('formats as markdown', () => {
    const output = formatReport([sampleReport], 'markdown');
    expect(output).toContain('migration.sql');
    // Markdown should contain some structural elements
    expect(output).toMatch(/#|##|\*|\|/);
  });

  it('formats as SARIF', () => {
    const output = formatReport([sampleReport], 'sarif');
    const parsed = JSON.parse(output);
    expect(parsed.$schema).toBeDefined();
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs).toBeDefined();
    expect(parsed.runs[0].results.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty reports', () => {
    const output = formatReport([], 'json');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(0);
  });

  it('formats with verbose flag', () => {
    const output = formatReport([sampleReport], 'terminal', true);
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });
});

// ─── formatDriftReport ───────────────────────────────────────────────────────

describe('formatDriftReport', () => {
  it('formats drift as terminal', () => {
    const output = formatDriftReport(sampleDriftReport, 'terminal');
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it('formats drift as JSON', () => {
    const output = formatDriftReport(sampleDriftReport, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.inSync).toBe(false);
    expect(parsed.totalFindings).toBe(2);
  });

  it('formats drift as markdown (falls back to JSON)', () => {
    const output = formatDriftReport(sampleDriftReport, 'markdown');
    const parsed = JSON.parse(output);
    expect(parsed.inSync).toBe(false);
  });

  it('formats drift as sarif (falls back to JSON)', () => {
    const output = formatDriftReport(sampleDriftReport, 'sarif');
    const parsed = JSON.parse(output);
    expect(parsed.totalFindings).toBe(2);
  });

  it('handles in-sync drift report', () => {
    const syncReport: DriftReport = {
      overallDrift: RiskLevel.Low,
      totalFindings: 0,
      findings: [],
      beforeTables: ['users'],
      afterTables: ['users'],
      inSync: true,
    };
    const output = formatDriftReport(syncReport, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.inSync).toBe(true);
    expect(parsed.totalFindings).toBe(0);
  });
});
