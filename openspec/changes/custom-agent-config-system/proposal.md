## Why

OMO 目前的 agent 体系（Sisyphus、Oracle、Explore 等）全部硬编码在源码中，用户无法在不修改代码的情况下新增自己的 primary agent 或 subagent。对于需要针对特定领域（如代码审查、数据处理、安全分析）定制专属 orchestrator + 子 agent 工作流的用户，现有机制缺乏扩展点。

## What Changes

- 新增全局配置文件 `~/.opencode/custom-agents.json`，支持声明式定义 custom agent 体系
- 新增 `custom-agent-config` 加载模块：读取、校验配置文件
- 新增 `createCustomAgents()` 函数：将配置转换为 `AgentConfig` 对象并注入 opencode
- 新增 `buildCustomPrimaryPrompt()` 函数：基于 Sisyphus-lite 模板，动态生成 primary agent 的 orchestrator prompt（含委派表格、会话连续性约束）
- 扩展 `createDelegateTask` 工具：在 `resolveSubagentExecution()` 中加入 custom subagent 隔离校验（Hard Isolation）
- 每个 custom primary agent 形成独立的 agent 生态（"独立王国"），与 Sisyphus 平行存在，互不可见

支持的 agent 类型：
- `primary`：出现在 UI 模型选择器，拥有 `task` 委派权限，不能被其他 agent 委派
- `subagent`：只能被显式配置了它的 primary 通过 `task` 工具委派
- `all`：既可主导对话，也可被委派（兼容 OpenCode 原生格式）

## Capabilities

### New Capabilities

- `custom-agent-config-schema`：custom-agents.json 的配置格式定义与校验逻辑（字段、类型、约束）
- `custom-agent-loader`：从全局配置文件加载并注册 custom agents 到 opencode agent 列表
- `custom-primary-prompt-builder`：基于 Sisyphus-lite 模板为 primary agent 动态生成 orchestrator prompt
- `custom-subagent-isolation`：task 工具运行时校验，确保 primary 只能委派其配置列表中的 subagents

### Modified Capabilities

- `builtin-agents`：`createBuiltinAgents()` 末尾合并 custom agents 结果，将 custom agents 注入 opencode

## Impact

- **新增文件**：
  - `src/agents/custom-agents/index.ts`（入口）
  - `src/agents/custom-agents/config-loader.ts`（配置加载）
  - `src/agents/custom-agents/config-schema.ts`（Zod schema 校验）
  - `src/agents/custom-agents/prompt-builder.ts`（Sisyphus-lite 模板）
  - `src/agents/custom-agents/agent-factory.ts`（AgentConfig 工厂）
- **修改文件**：
  - `src/agents/builtin-agents.ts`：调用 `createCustomAgents()` 并合并结果
  - `src/tools/delegate-task/`：`resolveSubagentExecution()` 加入 isolation 校验
- **新增全局配置文件格式**：`~/.opencode/custom-agents.json`（用户侧，不影响项目源码）
- **无 breaking changes**：所有现有内置 agent 行为不变，custom agents 完全增量叠加
