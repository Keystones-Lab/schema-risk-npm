// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — Terminal Formatter
// ─────────────────────────────────────────────────────────────────────────────

import chalk from 'chalk';
import type { MigrationReport, DriftReport } from '../types.js';
import { RiskLevel, riskGte } from '../types.js';

function riskColor(level: RiskLevel): string {
  switch (level) {
    case RiskLevel.Low:
      return chalk.green.bold(level);
    case RiskLevel.Medium:
      return chalk.yellow.bold(level);
    case RiskLevel.High:
      return chalk.rgb(255, 140, 0).bold(level);
    case RiskLevel.Critical:
      return chalk.red.bold(level);
  }
}

export function renderTerminal(report: MigrationReport, verbose = false): string {
  const lines: string[] = [];
  const sep = chalk.dim('─'.repeat(60));

  lines.push('');
  lines.push(sep);
  lines.push(`${chalk.bold(' SchemaRisk Analysis')}  ${chalk.cyan(report.file)}`);
  lines.push(sep);

  lines.push('');
  lines.push(
    `  Migration Risk:  ${riskColor(report.overallRisk)}   (score: ${chalk.bold(String(report.score))})`,
  );

  if (report.affectedTables.length > 0) {
    lines.push('');
    lines.push(
      `  ${chalk.bold('Tables affected:')} ${chalk.cyan(report.affectedTables.join(', '))}`,
    );
  }

  if (report.estimatedLockSeconds != null) {
    const secs = report.estimatedLockSeconds;
    const lockStr =
      secs >= 60 ? `~${Math.floor(secs / 60)} min ${secs % 60} sec` : `~${secs} sec`;
    const colored =
      secs > 30 ? chalk.red(lockStr) : secs > 5 ? chalk.yellow(lockStr) : chalk.green(lockStr);
    lines.push(`  ${chalk.bold('Estimated lock duration:')} ${colored}`);
  }

  if (report.indexRebuildRequired) {
    lines.push(`  ${chalk.bold('Index rebuild required:')} ${chalk.red.bold('YES')}`);
  }

  if (report.requiresMaintenanceWindow) {
    lines.push(`  ${chalk.bold('Requires maintenance window:')} ${chalk.red.bold('YES')}`);
  }

  if (verbose && report.operations.length > 0) {
    lines.push('');
    lines.push(`  ${chalk.bold.underline('Detected Operations')}:`);
    for (const op of report.operations) {
      lines.push(`    ${chalk.dim('•')} [${riskColor(op.riskLevel)}] ${op.description}`);
      if (op.acquiresLock) {
        lines.push(`       ${chalk.yellow('⚠')} acquires ${op.lockMode ?? 'table'} lock`);
      }
      if (op.indexRebuild) {
        lines.push(`       ${chalk.yellow('⟳')} triggers index rebuild`);
      }
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`  ${chalk.bold.underline('Warnings')}:`);
    for (const w of report.warnings) {
      lines.push(`    ${chalk.yellow.bold('!')} ${w}`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push(`  ${chalk.bold.underline('Recommendations')}:`);
    for (const r of report.recommendations) {
      lines.push(`    ${chalk.green('→')} ${r}`);
    }
  }

  lines.push('');
  lines.push(sep);

  if (report.requiresMaintenanceWindow) {
    lines.push(chalk.red('  ⛔ This migration should NOT be deployed without review'));
  } else if (riskGte(report.overallRisk, RiskLevel.Medium)) {
    lines.push(chalk.yellow('  ⚠  Review recommended before deploying'));
  } else {
    lines.push(chalk.green('  ✓  Migration looks safe'));
  }

  lines.push('');
  return lines.join('\n');
}

export function renderDriftTerminal(report: DriftReport): string {
  const lines: string[] = [];
  const sep = chalk.dim('─'.repeat(60));

  lines.push('');
  lines.push(sep);
  lines.push(chalk.bold(' Schema Drift Report'));
  lines.push(sep);

  if (report.inSync) {
    lines.push('');
    lines.push(chalk.green('  ✓  Schemas are in sync. No drift detected.'));
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`  Drift severity: ${riskColor(report.overallDrift)}`);
  lines.push(`  Total findings: ${chalk.bold(String(report.totalFindings))}`);

  lines.push('');
  for (const f of report.findings) {
    lines.push(`  ${chalk.dim('•')} [${riskColor(f.severity)}] ${f.description}`);
  }

  lines.push('');
  lines.push(sep);
  return lines.join('\n');
}
