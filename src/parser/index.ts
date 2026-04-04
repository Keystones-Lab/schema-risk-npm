// ─────────────────────────────────────────────────────────────────────────────
// Schema-Risk — SQL DDL Parser
//
// Purpose-built PostgreSQL DDL parser that normalises raw SQL into
// ParsedStatement objects. Uses regex-based pattern matching for the finite
// set of DDL statements we need to analyse.
// ─────────────────────────────────────────────────────────────────────────────

import type { ColumnInfo, ForeignKeyInfo, ParsedStatement } from '../types.js';

// Belt-and-suspenders unsafe keyword list
const UNSAFE_KEYWORDS = [
  'DROP TABLE',
  'DROP DATABASE',
  'DROP SCHEMA',
  'TRUNCATE',
  'ALTER TABLE',
] as const;

function checkUnsafeKeywords(raw: string): string | null {
  const upper = raw.toUpperCase();
  for (const kw of UNSAFE_KEYWORDS) {
    if (upper.includes(kw)) {
      return `Unmodelled DDL containing '${kw}' — manual review required`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function parseSQL(sql: string): ParsedStatement[] {
  const segments = splitIntoSegments(sql);
  const results: ParsedStatement[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const parsed = classifyStatement(trimmed);
    if (parsed) {
      results.push(parsed);
    } else {
      const note = checkUnsafeKeywords(trimmed);
      const raw = note ? `${trimmed.slice(0, 120)} [${note}]` : trimmed.slice(0, 120);
      results.push({ kind: 'Other', raw });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment splitting — respects dollar-quoting and semicolons
// ─────────────────────────────────────────────────────────────────────────────

function splitIntoSegments(sql: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';
  const chars = [...sql];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] === '$') {
      let j = i + 1;
      while (j < chars.length && chars[j] !== '$' && /[\w]/.test(chars[j])) j++;
      if (j < chars.length && chars[j] === '$') {
        const tag = chars.slice(i, j + 1).join('');
        if (!inDollarQuote) {
          inDollarQuote = true;
          dollarTag = tag;
          current += tag;
          i = j + 1;
          continue;
        } else if (tag === dollarTag) {
          inDollarQuote = false;
          current += tag;
          dollarTag = '';
          i = j + 1;
          continue;
        }
      }
    }

    if (!inDollarQuote && chars[i] === ';') {
      const seg = current.trim();
      if (seg) segments.push(seg);
      current = '';
      i++;
      continue;
    }

    current += chars[i];
    i++;
  }

  const leftover = current.trim();
  if (leftover) {
    for (const block of leftover.split(/\n\n+/)) {
      const b = block.trim();
      if (b) segments.push(b);
    }
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Statement classification
// ─────────────────────────────────────────────────────────────────────────────

function classifyStatement(sql: string): ParsedStatement | null {
  // Strip leading comments
  const cleaned = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .trim();
  const cleanedUpper = cleaned.toUpperCase().replace(/\s+/g, ' ').trim();

  if (cleanedUpper.startsWith('CREATE TABLE')) return parseCreateTable(cleaned);
  if (cleanedUpper.startsWith('DROP TABLE')) return parseDropTable(cleaned);
  if (cleanedUpper.startsWith('TRUNCATE')) return parseTruncate(cleaned);
  if (cleanedUpper.startsWith('CREATE') && /CREATE\s+(UNIQUE\s+)?INDEX/i.test(cleanedUpper))
    return parseCreateIndex(cleaned);
  if (cleanedUpper.startsWith('DROP INDEX')) return parseDropIndex(cleaned);
  if (cleanedUpper.startsWith('ALTER TABLE')) return parseAlterTable(cleaned);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE TABLE
// ─────────────────────────────────────────────────────────────────────────────

function parseCreateTable(sql: string): ParsedStatement {
  const nameMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(/i);
  const table = nameMatch ? stripQuotes(nameMatch[1]) : 'unknown';

  const bodyMatch = sql.match(/\((.+)\)\s*$/s);
  const body = bodyMatch ? bodyMatch[1] : '';

  const columns: ColumnInfo[] = [];
  const foreignKeys: ForeignKeyInfo[] = [];
  let hasPrimaryKey = false;

  const parts = splitTopLevel(body);

  for (const part of parts) {
    const trimmed = part.trim();
    const upper = trimmed.toUpperCase();

    // Table-level CONSTRAINT … FOREIGN KEY
    if (upper.includes('FOREIGN KEY')) {
      const fk = parseForeignKeyConstraint(trimmed);
      if (fk) foreignKeys.push(fk);
      continue;
    }

    // Table-level PRIMARY KEY(…)
    if (/^\s*(CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY/i.test(trimmed)) {
      hasPrimaryKey = true;
      continue;
    }

    // Table-level UNIQUE(…), CHECK(…), EXCLUDE — skip
    if (/^\s*(CONSTRAINT\s+\S+\s+)?(UNIQUE|CHECK|EXCLUDE)/i.test(trimmed)) continue;

    // Column definition
    const col = parseColumnDef(trimmed);
    if (col) {
      columns.push(col);
      if (col.isPrimaryKey) hasPrimaryKey = true;
    }
  }

  return { kind: 'CreateTable', table, columns, foreignKeys, hasPrimaryKey };
}

function parseColumnDef(def: string): ColumnInfo | null {
  const match = def.match(/^(\S+)\s+(.+)$/s);
  if (!match) return null;

  const name = stripQuotes(match[1]);
  const rest = match[2].trim();
  const upper = rest.toUpperCase();

  // Extract data type (first word or words until a keyword)
  const typeMatch = rest.match(
    /^(\S+(?:\s*\([^)]*\))?(?:\s+(?:VARYING|PRECISION|WITH(?:OUT)?\s+TIME\s+ZONE))?)/i,
  );
  const dataType = typeMatch ? typeMatch[1].trim() : rest.split(/\s/)[0];

  const nullable = !upper.includes('NOT NULL');
  const hasDefault = upper.includes('DEFAULT');
  const isPrimaryKey = upper.includes('PRIMARY KEY');

  // Filter out keywords that look like column names
  if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(name)) return null;

  return { name, dataType, nullable, hasDefault, isPrimaryKey };
}

function parseForeignKeyConstraint(def: string): ForeignKeyInfo | null {
  const constraintMatch = def.match(/CONSTRAINT\s+(\S+)/i);
  const colsMatch = def.match(/FOREIGN\s+KEY\s*\(([^)]+)\)/i);
  const refMatch = def.match(/REFERENCES\s+(\S+)\s*\(([^)]+)\)/i);

  if (!colsMatch || !refMatch) return null;

  const columns = colsMatch[1].split(',').map((c) => stripQuotes(c.trim()));
  const refTable = stripQuotes(refMatch[1]);
  const refColumns = refMatch[2].split(',').map((c) => stripQuotes(c.trim()));
  const upper = def.toUpperCase();

  return {
    columns,
    refTable,
    refColumns,
    onDeleteCascade: upper.includes('ON DELETE CASCADE'),
    onUpdateCascade: upper.includes('ON UPDATE CASCADE'),
    constraintName: constraintMatch ? stripQuotes(constraintMatch[1]) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP TABLE
// ─────────────────────────────────────────────────────────────────────────────

function parseDropTable(sql: string): ParsedStatement {
  const upper = sql.toUpperCase();
  const ifExists = upper.includes('IF EXISTS');
  const cascade = upper.includes('CASCADE');

  const stripped = sql
    .replace(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?/i, '')
    .replace(/\s*(CASCADE|RESTRICT)\s*$/i, '')
    .trim();
  const tables = stripped.split(',').map((t) => stripQuotes(t.trim()));

  return { kind: 'DropTable', tables, ifExists, cascade };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRUNCATE
// ─────────────────────────────────────────────────────────────────────────────

function parseTruncate(sql: string): ParsedStatement {
  const stripped = sql.replace(/TRUNCATE\s+(TABLE\s+)?/i, '').trim();
  const tables = stripped
    .replace(/\s*(CASCADE|RESTRICT)\s*$/i, '')
    .split(',')
    .map((t) => stripQuotes(t.trim()));
  return { kind: 'TruncateTable', tables };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE INDEX
// ─────────────────────────────────────────────────────────────────────────────

function parseCreateIndex(sql: string): ParsedStatement {
  const upper = sql.toUpperCase();
  const unique = upper.includes('UNIQUE');
  const concurrently = upper.includes('CONCURRENTLY');

  const pattern =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)\s*\(([^)]+)\)/i;
  const match = sql.match(pattern);

  if (match) {
    return {
      kind: 'CreateIndex',
      indexName: stripQuotes(match[1]),
      table: stripQuotes(match[2]),
      columns: match[3].split(',').map((c) => stripQuotes(c.trim())),
      unique,
      concurrently,
    };
  }

  // Fallback: index without explicit name
  const fallback =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?ON\s+(\S+)\s*\(([^)]+)\)/i;
  const fb = sql.match(fallback);
  if (fb) {
    return {
      kind: 'CreateIndex',
      table: stripQuotes(fb[1]),
      columns: fb[2].split(',').map((c) => stripQuotes(c.trim())),
      unique,
      concurrently,
    };
  }

  return { kind: 'Other', raw: sql.slice(0, 120) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP INDEX
// ─────────────────────────────────────────────────────────────────────────────

function parseDropIndex(sql: string): ParsedStatement {
  const upper = sql.toUpperCase();
  const concurrently = upper.includes('CONCURRENTLY');
  const ifExists = upper.includes('IF EXISTS');

  const stripped = sql
    .replace(/DROP\s+INDEX\s+(CONCURRENTLY\s+)?(IF\s+EXISTS\s+)?/i, '')
    .trim();
  const names = stripped.split(',').map((n) => stripQuotes(n.trim()));

  return { kind: 'DropIndex', names, concurrently, ifExists };
}

// ─────────────────────────────────────────────────────────────────────────────
// ALTER TABLE
// ─────────────────────────────────────────────────────────────────────────────

function parseAlterTable(sql: string): ParsedStatement | null {
  const tableMatch = sql.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(\S+)\s+/i);
  if (!tableMatch) return null;
  const table = stripQuotes(tableMatch[1]);
  const rest = sql.slice(tableMatch[0].length).trim();
  const restUpper = rest.toUpperCase().replace(/\s+/g, ' ').trim();

  // ADD COLUMN
  if (restUpper.startsWith('ADD COLUMN') || /^ADD\s+(?!CONSTRAINT|PRIMARY)/i.test(restUpper)) {
    return parseAlterAddColumn(table, rest);
  }

  // DROP COLUMN
  if (restUpper.startsWith('DROP COLUMN') || /^DROP\s+(?!CONSTRAINT)/i.test(restUpper)) {
    return parseAlterDropColumn(table, rest);
  }

  // ALTER COLUMN … TYPE
  if (/^ALTER\s+(COLUMN\s+)?(\S+)\s+(SET\s+DATA\s+)?TYPE/i.test(restUpper)) {
    return parseAlterColumnType(table, rest);
  }

  // ALTER COLUMN … SET NOT NULL
  if (/^ALTER\s+(COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL/i.test(restUpper)) {
    const colMatch = rest.match(/ALTER\s+(?:COLUMN\s+)?(\S+)\s+SET\s+NOT\s+NULL/i);
    return colMatch
      ? { kind: 'AlterTableSetNotNull', table, column: stripQuotes(colMatch[1]) }
      : null;
  }

  // ALTER COLUMN … DROP NOT NULL
  if (/^ALTER\s+(COLUMN\s+)?\S+\s+DROP\s+NOT\s+NULL/i.test(restUpper)) {
    const colMatch = rest.match(/ALTER\s+(?:COLUMN\s+)?(\S+)\s+DROP\s+NOT\s+NULL/i);
    return colMatch
      ? { kind: 'AlterTableDropNotNull', table, column: stripQuotes(colMatch[1]) }
      : null;
  }

  // ALTER COLUMN … SET DEFAULT / DROP DEFAULT
  if (/^ALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DEFAULT|DROP\s+DEFAULT)/i.test(restUpper)) {
    const colMatch = rest.match(
      /ALTER\s+(?:COLUMN\s+)?(\S+)\s+(SET\s+DEFAULT|DROP\s+DEFAULT)/i,
    );
    if (colMatch) {
      return {
        kind: 'AlterTableAlterColumnDefault',
        table,
        column: stripQuotes(colMatch[1]),
        dropDefault: colMatch[2].toUpperCase().startsWith('DROP'),
      };
    }
  }

  // ADD CONSTRAINT … FOREIGN KEY
  if (/^ADD\s+CONSTRAINT/i.test(restUpper) && restUpper.includes('FOREIGN KEY')) {
    const fk = parseForeignKeyConstraint(rest);
    return fk ? { kind: 'AlterTableAddForeignKey', table, fk } : null;
  }

  // ADD PRIMARY KEY
  if (restUpper.includes('ADD PRIMARY KEY') || restUpper.includes('ADD CONSTRAINT')) {
    const pkMatch = rest.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (pkMatch) {
      return {
        kind: 'AlterTableAddPrimaryKey',
        table,
        columns: pkMatch[1].split(',').map((c) => stripQuotes(c.trim())),
      };
    }
  }

  // DROP CONSTRAINT
  if (restUpper.startsWith('DROP CONSTRAINT')) {
    const match = rest.match(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
    if (match) {
      return {
        kind: 'AlterTableDropConstraint',
        table,
        constraint: stripQuotes(match[1]),
        cascade: restUpper.includes('CASCADE'),
      };
    }
  }

  // RENAME COLUMN
  if (restUpper.includes('RENAME COLUMN') || /^RENAME\s+\S+\s+TO\s+/i.test(restUpper)) {
    const match = rest.match(/RENAME\s+(?:COLUMN\s+)?(\S+)\s+TO\s+(\S+)/i);
    if (match) {
      return {
        kind: 'AlterTableRenameColumn',
        table,
        oldName: stripQuotes(match[1]),
        newName: stripQuotes(match[2]),
      };
    }
  }

  // RENAME TABLE
  if (restUpper.startsWith('RENAME TO')) {
    const match = rest.match(/RENAME\s+TO\s+(\S+)/i);
    if (match) {
      return {
        kind: 'AlterTableRenameTable',
        oldName: table,
        newName: stripQuotes(match[1]),
      };
    }
  }

  return null;
}

function parseAlterAddColumn(table: string, rest: string): ParsedStatement {
  const stripped = rest.replace(/^ADD\s+(COLUMN\s+)?/i, '').trim();
  const col = parseColumnDef(stripped);
  if (col) {
    return { kind: 'AlterTableAddColumn', table, column: col };
  }
  // Fallback: extract at least the name
  const parts = stripped.split(/\s+/);
  return {
    kind: 'AlterTableAddColumn',
    table,
    column: {
      name: stripQuotes(parts[0]),
      dataType: parts[1] || 'unknown',
      nullable: !stripped.toUpperCase().includes('NOT NULL'),
      hasDefault: stripped.toUpperCase().includes('DEFAULT'),
      isPrimaryKey: false,
    },
  };
}

function parseAlterDropColumn(table: string, rest: string): ParsedStatement {
  const upper = rest.toUpperCase();
  const ifExists = upper.includes('IF EXISTS');
  const stripped = rest.replace(/^DROP\s+(COLUMN\s+)?(IF\s+EXISTS\s+)?/i, '').trim();
  const column = stripQuotes(stripped.split(/\s/)[0]);
  return { kind: 'AlterTableDropColumn', table, column, ifExists };
}

function parseAlterColumnType(table: string, rest: string): ParsedStatement {
  const match = rest.match(
    /ALTER\s+(?:COLUMN\s+)?(\S+)\s+(?:SET\s+DATA\s+)?TYPE\s+(.+?)(?:\s+USING\s+.*)?$/i,
  );
  if (match) {
    return {
      kind: 'AlterTableAlterColumnType',
      table,
      column: stripQuotes(match[1]),
      newType: match[2].trim(),
    };
  }
  return { kind: 'Other', raw: rest.slice(0, 120) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function stripQuotes(s: string): string {
  return s.replace(/^["'`]+|["'`]+$/g, '').replace(/;$/, '');
}

/**
 * Split a string on commas that are NOT inside parentheses.
 * Used for parsing CREATE TABLE column/constraint lists.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const ch of body) {
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  const last = current.trim();
  if (last) parts.push(last);

  return parts;
}
