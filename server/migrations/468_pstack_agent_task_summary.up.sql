-- One-time, model-written headline for the active board: what this task is set
-- to do, in one or two plain sentences. Written once by TaskService.StartTask
-- through the server-internal LLM layer; NULL when the LLM layer is disabled,
-- the call failed, or the task started before this column existed. The
-- pstack_ prefix keeps this fork's column clear of upstream names.
ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS pstack_summary TEXT;
