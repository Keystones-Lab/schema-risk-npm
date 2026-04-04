import { describe, it, expect } from 'vitest';
import { parseSQL } from '../src/parser/index.js';

describe('parseSQL', () => {
  // ─── CREATE TABLE ────────────────────────────────────────────────────────

  describe('CREATE TABLE', () => {
    it('parses a simple CREATE TABLE', () => {
      const sql = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email TEXT
        );
      `;
      const stmts = parseSQL(sql);
      expect(stmts).toHaveLength(1);
      expect(stmts[0].kind).toBe('CreateTable');
      if (stmts[0].kind === 'CreateTable') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].columns.length).toBeGreaterThanOrEqual(3);
        expect(stmts[0].columns[0].name).toBe('id');
        expect(stmts[0].columns[0].dataType).toMatch(/serial/i);
        expect(stmts[0].columns[1].name).toBe('name');
        expect(stmts[0].columns[1].nullable).toBe(false);
        expect(stmts[0].columns[2].name).toBe('email');
        expect(stmts[0].columns[2].nullable).toBe(true);
        expect(stmts[0].hasPrimaryKey).toBe(true);
      }
    });

    it('parses CREATE TABLE with table-level foreign key', () => {
      const sql = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          total NUMERIC(10,2),
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;
      const stmts = parseSQL(sql);
      expect(stmts).toHaveLength(1);
      if (stmts[0].kind === 'CreateTable') {
        expect(stmts[0].table).toBe('orders');
        const fks = stmts[0].foreignKeys;
        expect(fks.length).toBeGreaterThanOrEqual(1);
        expect(fks[0].refTable).toBe('users');
        expect(fks[0].constraintName).toBe('fk_user');
      }
    });

    it('detects primary key from column definition', () => {
      const sql = `CREATE TABLE t (id INT PRIMARY KEY, name TEXT);`;
      const stmts = parseSQL(sql);
      if (stmts[0].kind === 'CreateTable') {
        expect(stmts[0].hasPrimaryKey).toBe(true);
      }
    });

    it('handles IF NOT EXISTS', () => {
      const sql = `CREATE TABLE IF NOT EXISTS users (id INT);`;
      const stmts = parseSQL(sql);
      expect(stmts[0].kind).toBe('CreateTable');
      if (stmts[0].kind === 'CreateTable') {
        expect(stmts[0].table).toBe('users');
      }
    });

    it('handles schema-qualified table names', () => {
      const sql = `CREATE TABLE public.users (id INT);`;
      const stmts = parseSQL(sql);
      if (stmts[0].kind === 'CreateTable') {
        expect(stmts[0].table).toBe('public.users');
      }
    });
  });

  // ─── DROP TABLE ──────────────────────────────────────────────────────────

  describe('DROP TABLE', () => {
    it('parses DROP TABLE', () => {
      const stmts = parseSQL('DROP TABLE users;');
      expect(stmts).toHaveLength(1);
      expect(stmts[0].kind).toBe('DropTable');
      if (stmts[0].kind === 'DropTable') {
        expect(stmts[0].tables).toContain('users');
        expect(stmts[0].cascade).toBe(false);
      }
    });

    it('detects CASCADE', () => {
      const stmts = parseSQL('DROP TABLE IF EXISTS users CASCADE;');
      if (stmts[0].kind === 'DropTable') {
        expect(stmts[0].tables).toContain('users');
        expect(stmts[0].cascade).toBe(true);
        expect(stmts[0].ifExists).toBe(true);
      }
    });
  });

  // ─── ALTER TABLE ─────────────────────────────────────────────────────────

  describe('ALTER TABLE', () => {
    it('parses ADD COLUMN', () => {
      const stmts = parseSQL('ALTER TABLE users ADD COLUMN age INTEGER NOT NULL DEFAULT 0;');
      expect(stmts).toHaveLength(1);
      expect(stmts[0].kind).toBe('AlterTableAddColumn');
      if (stmts[0].kind === 'AlterTableAddColumn') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].column.name).toBe('age');
        expect(stmts[0].column.dataType).toMatch(/integer/i);
        expect(stmts[0].column.nullable).toBe(false);
        expect(stmts[0].column.hasDefault).toBe(true);
      }
    });

    it('parses ADD COLUMN without COLUMN keyword', () => {
      const stmts = parseSQL('ALTER TABLE users ADD age INTEGER;');
      expect(stmts[0].kind).toBe('AlterTableAddColumn');
    });

    it('parses DROP COLUMN', () => {
      const stmts = parseSQL('ALTER TABLE users DROP COLUMN email;');
      expect(stmts[0].kind).toBe('AlterTableDropColumn');
      if (stmts[0].kind === 'AlterTableDropColumn') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].column).toBe('email');
      }
    });

    it('parses ALTER COLUMN TYPE', () => {
      const stmts = parseSQL('ALTER TABLE users ALTER COLUMN name TYPE TEXT;');
      expect(stmts[0].kind).toBe('AlterTableAlterColumnType');
      if (stmts[0].kind === 'AlterTableAlterColumnType') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].column).toBe('name');
        expect(stmts[0].newType).toMatch(/text/i);
      }
    });

    it('parses SET NOT NULL', () => {
      const stmts = parseSQL('ALTER TABLE users ALTER COLUMN email SET NOT NULL;');
      expect(stmts[0].kind).toBe('AlterTableSetNotNull');
      if (stmts[0].kind === 'AlterTableSetNotNull') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].column).toBe('email');
      }
    });

    it('parses DROP NOT NULL', () => {
      const stmts = parseSQL('ALTER TABLE users ALTER COLUMN email DROP NOT NULL;');
      expect(stmts[0].kind).toBe('AlterTableDropNotNull');
      if (stmts[0].kind === 'AlterTableDropNotNull') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].column).toBe('email');
      }
    });

    it('parses ADD FOREIGN KEY constraint', () => {
      const sql = `ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);`;
      const stmts = parseSQL(sql);
      expect(stmts[0].kind).toBe('AlterTableAddForeignKey');
      if (stmts[0].kind === 'AlterTableAddForeignKey') {
        expect(stmts[0].table).toBe('orders');
        expect(stmts[0].fk.constraintName).toBe('fk_user');
        expect(stmts[0].fk.refTable).toBe('users');
        expect(stmts[0].fk.columns).toContain('user_id');
        expect(stmts[0].fk.refColumns).toContain('id');
      }
    });

    it('parses DROP CONSTRAINT', () => {
      const stmts = parseSQL('ALTER TABLE orders DROP CONSTRAINT fk_user;');
      expect(stmts[0].kind).toBe('AlterTableDropConstraint');
      if (stmts[0].kind === 'AlterTableDropConstraint') {
        expect(stmts[0].table).toBe('orders');
        expect(stmts[0].constraint).toBe('fk_user');
      }
    });

    it('parses RENAME COLUMN', () => {
      const stmts = parseSQL('ALTER TABLE users RENAME COLUMN email TO email_address;');
      expect(stmts[0].kind).toBe('AlterTableRenameColumn');
      if (stmts[0].kind === 'AlterTableRenameColumn') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].oldName).toBe('email');
        expect(stmts[0].newName).toBe('email_address');
      }
    });

    it('parses RENAME TABLE', () => {
      const stmts = parseSQL('ALTER TABLE users RENAME TO customers;');
      expect(stmts[0].kind).toBe('AlterTableRenameTable');
      if (stmts[0].kind === 'AlterTableRenameTable') {
        expect(stmts[0].oldName).toBe('users');
        expect(stmts[0].newName).toBe('customers');
      }
    });

    it('parses ALTER COLUMN SET DEFAULT', () => {
      const stmts = parseSQL("ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';");
      expect(stmts[0].kind).toBe('AlterTableAlterColumnDefault');
      if (stmts[0].kind === 'AlterTableAlterColumnDefault') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].column).toBe('status');
        expect(stmts[0].dropDefault).toBe(false);
      }
    });

    it('parses ALTER COLUMN DROP DEFAULT', () => {
      const stmts = parseSQL('ALTER TABLE users ALTER COLUMN status DROP DEFAULT;');
      expect(stmts[0].kind).toBe('AlterTableAlterColumnDefault');
      if (stmts[0].kind === 'AlterTableAlterColumnDefault') {
        expect(stmts[0].dropDefault).toBe(true);
      }
    });

    it('parses ADD PRIMARY KEY', () => {
      const sql = `ALTER TABLE users ADD CONSTRAINT pk_users PRIMARY KEY (id);`;
      const stmts = parseSQL(sql);
      expect(stmts[0].kind).toBe('AlterTableAddPrimaryKey');
      if (stmts[0].kind === 'AlterTableAddPrimaryKey') {
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].columns).toContain('id');
      }
    });
  });

  // ─── CREATE INDEX ────────────────────────────────────────────────────────

  describe('CREATE INDEX', () => {
    it('parses a simple CREATE INDEX', () => {
      const stmts = parseSQL('CREATE INDEX idx_users_email ON users (email);');
      expect(stmts[0].kind).toBe('CreateIndex');
      if (stmts[0].kind === 'CreateIndex') {
        expect(stmts[0].indexName).toBe('idx_users_email');
        expect(stmts[0].table).toBe('users');
        expect(stmts[0].columns).toContain('email');
        expect(stmts[0].unique).toBe(false);
        expect(stmts[0].concurrently).toBe(false);
      }
    });

    it('detects UNIQUE INDEX', () => {
      const stmts = parseSQL('CREATE UNIQUE INDEX idx_email ON users (email);');
      if (stmts[0].kind === 'CreateIndex') {
        expect(stmts[0].unique).toBe(true);
      }
    });

    it('detects CONCURRENTLY', () => {
      const stmts = parseSQL('CREATE INDEX CONCURRENTLY idx_email ON users (email);');
      if (stmts[0].kind === 'CreateIndex') {
        expect(stmts[0].concurrently).toBe(true);
      }
    });
  });

  // ─── DROP INDEX ──────────────────────────────────────────────────────────

  describe('DROP INDEX', () => {
    it('parses DROP INDEX', () => {
      const stmts = parseSQL('DROP INDEX idx_users_email;');
      expect(stmts[0].kind).toBe('DropIndex');
      if (stmts[0].kind === 'DropIndex') {
        expect(stmts[0].names).toContain('idx_users_email');
        expect(stmts[0].concurrently).toBe(false);
      }
    });

    it('detects DROP INDEX CONCURRENTLY', () => {
      const stmts = parseSQL('DROP INDEX CONCURRENTLY idx_users_email;');
      if (stmts[0].kind === 'DropIndex') {
        expect(stmts[0].concurrently).toBe(true);
      }
    });
  });

  // ─── TRUNCATE ────────────────────────────────────────────────────────────

  describe('TRUNCATE', () => {
    it('parses TRUNCATE TABLE', () => {
      const stmts = parseSQL('TRUNCATE TABLE users;');
      expect(stmts[0].kind).toBe('TruncateTable');
      if (stmts[0].kind === 'TruncateTable') {
        expect(stmts[0].tables).toContain('users');
      }
    });

    it('parses TRUNCATE without TABLE keyword', () => {
      const stmts = parseSQL('TRUNCATE users;');
      expect(stmts[0].kind).toBe('TruncateTable');
    });
  });

  // ─── Multi-statement ─────────────────────────────────────────────────────

  describe('multi-statement', () => {
    it('handles multiple statements', () => {
      const sql = `
        CREATE TABLE users (id INT);
        CREATE TABLE orders (id INT);
        DROP TABLE users;
      `;
      const stmts = parseSQL(sql);
      expect(stmts).toHaveLength(3);
      expect(stmts[0].kind).toBe('CreateTable');
      expect(stmts[1].kind).toBe('CreateTable');
      expect(stmts[2].kind).toBe('DropTable');
    });

    it('ignores empty statements', () => {
      const sql = ';;;';
      const stmts = parseSQL(sql);
      expect(stmts).toHaveLength(0);
    });

    it('handles comments', () => {
      const sql = `
        -- This is a comment
        CREATE TABLE users (id INT);
        /* Multi-line
           comment */
        DROP TABLE users;
      `;
      const stmts = parseSQL(sql);
      expect(stmts).toHaveLength(2);
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles dollar-quoted bodies', () => {
      const sql = `
        CREATE TABLE t (id INT);
        CREATE OR REPLACE FUNCTION test() RETURNS void AS $$
        BEGIN
          DROP TABLE t;
        END;
        $$ LANGUAGE plpgsql;
      `;
      const stmts = parseSQL(sql);
      expect(stmts.length).toBeGreaterThanOrEqual(1);
      expect(stmts[0].kind).toBe('CreateTable');
    });

    it('classifies unknown DDL as Other', () => {
      const stmts = parseSQL('SELECT 1;');
      expect(stmts).toHaveLength(1);
      expect(stmts[0].kind).toBe('Other');
      if (stmts[0].kind === 'Other') {
        expect(stmts[0].raw).toBeDefined();
      }
    });
  });
});
