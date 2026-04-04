// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — JSON Formatter
// ─────────────────────────────────────────────────────────────────────────────

import type { MigrationReport, DriftReport } from '../types.js';

export function renderJson(reports: MigrationReport[]): string {
  return JSON.stringify(
    reports.length === 1 ? reports[0] : reports,
    null,
    2,
  );
}

export function renderDriftJson(report: DriftReport): string {
  return JSON.stringify(report, null, 2);
}
