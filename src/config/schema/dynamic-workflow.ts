import { z } from "zod"

export const DynamicWorkflowConfigSchema = z.object({
  /** Enable the dynamic workflow tools (default: true) */
  enabled: z.boolean().optional(),
  /** Max concurrent subagents within a single workflow run (default: 16) */
  max_concurrency: z.number().int().min(1).max(32).optional(),
  /** Hard cap on agent() calls per run to prevent runaway loops (default: 1000) */
  max_agents_per_run: z.number().int().min(1).max(1000).optional(),
  /** Agent used for workflow subagents (default: "general") */
  default_subagent: z.string().optional(),
  /** Send a parent-session notification when a run finishes (default: true) */
  notify_on_complete: z.boolean().optional(),
  /** Persist successful workflow scripts to disk (default: true) */
  persist_scripts: z.boolean().optional().default(true),
  /** Directory for persisted scripts (default: .opencode/workflows) */
  scripts_dir: z.string().optional(),
  /** Persist workflow run checkpoints for resume (default: true) */
  persist_checkpoints: z.boolean().optional().default(true),
  /** Directory for workflow run checkpoints (default: .opencode/workflows/runs) */
  runs_dir: z.string().optional(),
})

export type DynamicWorkflowConfig = z.infer<typeof DynamicWorkflowConfigSchema>
