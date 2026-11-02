-- Fork-only: when true, a trigger is skipped while an issue this autopilot
-- created is still unresolved (not in a Done/Closed status category).
ALTER TABLE autopilot ADD COLUMN IF NOT EXISTS pstack_skip_while_open BOOLEAN NOT NULL DEFAULT false;
