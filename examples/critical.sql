-- examples/critical.sql
-- CRITICAL risk operations.

-- SR001: permanently destroys the entire sessions table and all its data.
DROP TABLE sessions;

-- SR010: destroys all rows in the audit_log table.
TRUNCATE TABLE audit_log;
