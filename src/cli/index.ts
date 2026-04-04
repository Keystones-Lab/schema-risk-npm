// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk CLI — Static analysis for PostgreSQL migration safety
// ─────────────────────────────────────────────────────────────────────────────

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname, join, relative } from 'node:path';

import { parseSQL } from '../parser/index.js';
import { SchemaHashTable, SchemaSimulator, diffSchemas } from '../engine/index.js';
import { scoreDeltas, buildReport } from '../rules/index.js';
import { loadConfig, generateConfigFile } from '../config/index.js';
import { formatReport, formatDriftReport, type OutputFormat } from '../formatters/index.js';
import { riskGte, parseRiskLevel, RiskLevel } from '../types.js';
import type { MigrationReport } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectSQLFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const resolved = resolve(p);
    if (!existsSync(resolved)) {
      console.error(`Path not found: ${p}`);
      process.exit(1);
    }
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      for (const child of readdirSync(resolved, { recursive: true })) {
        const childPath = join(resolved, String(child));
        if (extname(childPath).toLowerCase() === '.sql' && statSync(childPath).isFile()) {
          files.push(childPath);
        }
      }
    } else if (stat.isFile()) {
      files.push(resolved);
    }
  }
  return files.sort();
}

function parseTableRows(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  const result: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const [table, count] = pair.split('=');
    if (table && count) {
      result[table.trim()] = parseInt(count.trim(), 10);
    }
  }
  return result;
}

// ─── CLI Definition ──────────────────────────────────────────────────────────

const program = new Command();

program
  .name('schema-risk')
  .description('Static analysis for PostgreSQL migration safety')
  .version('1.0.0');

// ─── analyze ─────────────────────────────────────────────────────────────────

program
  .command('analyze')
  .description('Analyze SQL migration files for schema risk')
  .argument('<paths...>', 'SQL file(s) or directory to analyze')
  .option('-f, --format <format>', 'Output format: terminal, json, sarif, markdown', 'terminal')
  .option('-c, --config <path>', 'Path to schema-risk.yml config file')
  .option('--pg-version <version>', 'PostgreSQL major version (default: 14)', '14')
  .option('--table-rows <rows>', 'Estimated table rows: users=1000000,orders=5000000')
  .option('--fail-on <level>', 'Exit non-zero if any finding meets or exceeds risk level')
  .option('-v, --verbose', 'Show detailed output including low-risk items', false)
  .option('-o, --output <path>', 'Write output to file instead of stdout')
  .action(
    async (
      paths: string[],
      opts: {
        format: string;
        config?: string;
        pgVersion: string;
        tableRows?: string;
        failOn?: string;
        verbose: boolean;
        output?: string;
      },
    ) => {
      const config = loadConfig(opts.config);
      const pgVersion = parseInt(opts.pgVersion, 10);
      const tableRows = parseTableRows(opts.tableRows);
      const format = opts.format as OutputFormat;
      const files = collectSQLFiles(paths);

      if (files.length === 0) {
        console.error('No SQL files found.');
        process.exit(1);
      }

      const reports: MigrationReport[] = [];

      for (const filePath of files) {
        const sql = readFileSync(filePath, 'utf-8');
        const statements = parseSQL(sql);
        const simulator = new SchemaSimulator(tableRows);
        const { deltas } = simulator.simulate(statements);

        const operations = scoreDeltas(deltas, { pgVersion, tableRows, config });
        const displayPath = relative(process.cwd(), filePath);
        const report = buildReport(displayPath, operations, pgVersion);
        reports.push(report);
      }

      const output = formatReport(reports, format, opts.verbose);

      if (opts.output) {
        writeFileSync(resolve(opts.output), output, 'utf-8');
        console.error(`Report written to ${opts.output}`);
      } else {
        console.log(output);
      }

      // ─── Fail-on check ─────────────────────────────────────
      if (opts.failOn) {
        const threshold = parseRiskLevel(opts.failOn);
        if (threshold === undefined) {
          console.error(`Invalid risk level: ${opts.failOn}. Use: low, medium, high, critical`);
          process.exit(1);
        }
        const maxReportLevel = reports.reduce(
          (max, r) => {
            const lvl = r.overallRisk;
            return riskGte(lvl, max) ? lvl : max;
          },
          RiskLevel.Low,
        );
        if (riskGte(maxReportLevel, threshold)) {
          process.exit(2);
        }
      }

      // ─── Config-based threshold ─────────────────────────────
      if (!opts.failOn && config?.thresholds?.failOn) {
        const threshold = parseRiskLevel(config.thresholds.failOn);
        if (threshold !== undefined) {
          const maxReportLevel = reports.reduce(
            (max, r) => {
              const lvl = r.overallRisk;
              return riskGte(lvl, max) ? lvl : max;
            },
            RiskLevel.Low,
          );
          if (riskGte(maxReportLevel, threshold)) {
            process.exit(2);
          }
        }
      }
    },
  );

// ─── diff ────────────────────────────────────────────────────────────────────

program
  .command('diff')
  .description('Detect schema drift between two sets of migration files')
  .argument('<before>', 'SQL file(s) or directory representing the "before" state')
  .argument('<after>', 'SQL file(s) or directory representing the "after" state')
  .option('-f, --format <format>', 'Output format: terminal, json, markdown', 'terminal')
  .option('--pg-version <version>', 'PostgreSQL major version (default: 14)', '14')
  .option('--table-rows <rows>', 'Estimated table rows: users=1000000,orders=5000000')
  .option('-o, --output <path>', 'Write output to file instead of stdout')
  .action(
    (
      before: string,
      after: string,
      opts: {
        format: string;
        pgVersion: string;
        tableRows?: string;
        output?: string;
      },
    ) => {
      const tableRows = parseTableRows(opts.tableRows);

      function buildState(paths: string[]): SchemaHashTable {
        const files = collectSQLFiles(paths);
        const sim = new SchemaSimulator(tableRows);
        for (const f of files) {
          const sql = readFileSync(f, 'utf-8');
          sim.simulate(parseSQL(sql));
        }
        return sim.getState();
      }

      const beforeState = buildState([before]);
      const afterState = buildState([after]);
      const driftReport = diffSchemas(beforeState, afterState);

      const format = opts.format as OutputFormat;
      const output = formatDriftReport(driftReport, format);

      if (opts.output) {
        writeFileSync(resolve(opts.output), output, 'utf-8');
        console.error(`Drift report written to ${opts.output}`);
      } else {
        console.log(output);
      }

      if (driftReport.findings.length > 0) {
        process.exit(3);
      }
    },
  );

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Generate a schema-risk.yml configuration template')
  .option('-o, --output <path>', 'Output path', 'schema-risk.yml')
  .action((opts: { output: string }) => {
    const outputPath = resolve(opts.output);
    if (existsSync(outputPath)) {
      console.error(`File already exists: ${opts.output}`);
      process.exit(1);
    }
    generateConfigFile(outputPath);
    console.log(`Configuration template written to ${opts.output}`);
  });

// ─── ci-report ───────────────────────────────────────────────────────────────

program
  .command('ci-report')
  .description('Analyze and produce CI-friendly output (SARIF by default)')
  .argument('<paths...>', 'SQL file(s) or directory to analyze')
  .option('-f, --format <format>', 'Output format: sarif, json, markdown', 'sarif')
  .option('-c, --config <path>', 'Path to schema-risk.yml config file')
  .option('--pg-version <version>', 'PostgreSQL major version (default: 14)', '14')
  .option('--table-rows <rows>', 'Estimated table rows: users=1000000,orders=5000000')
  .option('-o, --output <path>', 'Write output to file instead of stdout')
  .action(
    (
      paths: string[],
      opts: {
        format: string;
        config?: string;
        pgVersion: string;
        tableRows?: string;
        output?: string;
      },
    ) => {
      const config = loadConfig(opts.config);
      const pgVersion = parseInt(opts.pgVersion, 10);
      const tableRows = parseTableRows(opts.tableRows);
      const format = opts.format as OutputFormat;
      const files = collectSQLFiles(paths);

      if (files.length === 0) {
        console.error('No SQL files found.');
        process.exit(1);
      }

      const reports: MigrationReport[] = [];

      for (const filePath of files) {
        const sql = readFileSync(filePath, 'utf-8');
        const statements = parseSQL(sql);
        const simulator = new SchemaSimulator(tableRows);
        const { deltas } = simulator.simulate(statements);
        const operations = scoreDeltas(deltas, { pgVersion, tableRows, config });
        const displayPath = relative(process.cwd(), filePath);
        const report = buildReport(displayPath, operations, pgVersion);
        reports.push(report);
      }

      const output = formatReport(reports, format, false);

      if (opts.output) {
        writeFileSync(resolve(opts.output), output, 'utf-8');
        console.error(`CI report written to ${opts.output}`);
      } else {
        console.log(output);
      }
    },
  );

// ─── Run ─────────────────────────────────────────────────────────────────────

program.parse();
