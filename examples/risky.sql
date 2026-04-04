-- examples/risky.sql
-- These operations will generate HIGH risk alerts and fix suggestions.

-- R06: CREATE INDEX without CONCURRENTLY — holds SHARE lock
CREATE INDEX idx_orders_status ON orders(status);

-- R05: ADD COLUMN NOT NULL without DEFAULT — fails on non-empty tables
ALTER TABLE users ADD COLUMN verified BOOLEAN NOT NULL;

-- R02: ALTER COLUMN TYPE — rewrites entire table under ACCESS EXCLUSIVE lock
ALTER TABLE orders ALTER COLUMN total TYPE NUMERIC(20, 4);
