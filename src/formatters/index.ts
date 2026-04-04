export { renderTerminal, renderDriftTerminal } from './terminal.js';
export { renderSarif } from './sarif.js';
export { renderJson, renderDriftJson } from './json.js';
export { renderMarkdown } from './markdown.js';

import type { MigrationReport, DriftReport } from '../types.js';
import { renderTerminal } from './terminal.js';
import { renderSarif } from './sarif.js';
import { renderJson, renderDriftJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { renderDriftTerminal } from './terminal.js';

export type OutputFormat = 'terminal' | 'json' | 'markdown' | 'sarif';

export function formatReport(
  reports: MigrationReport[],
  format: OutputFormat,
  verbose = false,
): string {
  switch (format) {
    case 'terminal':
      return reports.map((r) => renderTerminal(r, verbose)).join('\n');
    case 'json':
      return renderJson(reports);
    case 'markdown':
      return renderMarkdown(reports);
    case 'sarif':
      return renderSarif(reports);
  }
}

export function formatDriftReport(
  report: DriftReport,
  format: OutputFormat,
): string {
  switch (format) {
    case 'terminal':
      return renderDriftTerminal(report);
    case 'json':
      return renderDriftJson(report);
    case 'markdown':
    case 'sarif':
      return renderDriftJson(report);
  }
}
