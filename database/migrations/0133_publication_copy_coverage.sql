-- A copy (editorial/copies.ts) that its own material would list: listed nowhere, it still counts as its
-- fact's coverage (publication/scope.ts coverageCondition). Derived at publish time, like eligible.
ALTER TABLE publications ADD COLUMN copy_coverage boolean NOT NULL DEFAULT false;
