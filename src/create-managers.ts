import type { OhMyOpenCodeConfig } from "./config"
import type { ModelCacheState } from "./plugin-state"
import type { PluginContext, TmuxConfig } from "./plugin/types"

import type { SubagentSessionCreatedEvent } from "./features/background-agent"
import { BackgroundManager } from "./features/background-agent"
import { WorkflowManager } from "./features/dynamic-workflow"
import { SkillMcpManager } from "./features/skill-mcp-manager"
import { initTaskToastManager } from "./features/task-toast-manager"
import { TmuxSessionManager } from "./features/tmux-subagent"
import { registerManagerForCleanup } from "./features/background-agent/process-cleanup"
import { createConfigHandler } from "./plugin-handlers"
import { log } from "./shared"
import { markServerRunningInProcess } from "./shared/tmux/tmux-utils/server-health"

export type Managers = {
  tmuxSessionManager: TmuxSessionManager
  backgroundManager: BackgroundManager
  workflowManager: WorkflowManager
  skillMcpManager: SkillMcpManager
  configHandler: ReturnType<typeof createConfigHandler>
}

export function createManagers(args: {
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  tmuxConfig: TmuxConfig
  modelCacheState: ModelCacheState
  backgroundNotificationHookEnabled: boolean
}): Managers {
  const { ctx, pluginConfig, tmuxConfig, modelCacheState, backgroundNotificationHookEnabled } = args

  if (tmuxConfig.enabled) {
    markServerRunningInProcess()
  }
  const tmuxSessionManager = new TmuxSessionManager(ctx, tmuxConfig)

  registerManagerForCleanup({
    shutdown: async () => {
      await tmuxSessionManager.cleanup().catch((error) => {
        log("[create-managers] tmux cleanup error during process shutdown:", error)
      })
    },
  })

  const backgroundManager = new BackgroundManager(
    ctx,
    pluginConfig.background_task,
    {
      tmuxConfig,
		onSubagentSessionCreated: async (event: SubagentSessionCreatedEvent) => {
			log("[index] onSubagentSessionCreated callback received", {
				sessionID: event.sessionID,
				parentID: event.parentID,
          title: event.title,
        })

        await tmuxSessionManager.onSessionCreated({
          type: "session.created",
          properties: {
            info: {
              id: event.sessionID,
              parentID: event.parentID,
              title: event.title,
            },
          },
        })

        log("[index] onSubagentSessionCreated callback completed")
      },
      onShutdown: async () => {
        await tmuxSessionManager.cleanup().catch((error) => {
          log("[index] tmux cleanup error during shutdown:", error)
        })
      },
      enableParentSessionNotifications: backgroundNotificationHookEnabled,
    },
  )

  initTaskToastManager(ctx.client)

  const skillMcpManager = new SkillMcpManager()

  const workflowConfig = pluginConfig.dynamic_workflow
  const workflowManager = new WorkflowManager({
    client: ctx.client,
    backgroundManager,
    directory: ctx.directory,
    defaultSubagent: workflowConfig?.default_subagent,
    maxConcurrency: workflowConfig?.max_concurrency,
    maxAgentsPerRun: workflowConfig?.max_agents_per_run,
    enableParentNotifications: workflowConfig?.notify_on_complete ?? backgroundNotificationHookEnabled,
    persistScripts: workflowConfig?.persist_scripts ?? true,
    scriptsDir: workflowConfig?.scripts_dir,
    persistCheckpoints: workflowConfig?.persist_checkpoints ?? true,
    runsDir: workflowConfig?.runs_dir,
  })

  const configHandler = createConfigHandler({
    ctx: { directory: ctx.directory, client: ctx.client },
    pluginConfig,
    modelCacheState,
  })

  return {
    tmuxSessionManager,
    backgroundManager,
    workflowManager,
    skillMcpManager,
    configHandler,
  }
}
