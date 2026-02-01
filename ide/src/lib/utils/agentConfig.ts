/**
 * Agent Configuration Utility
 *
 * Handles reading/writing agent program configurations and routing rules.
 * Storage location: ~/.config/jat/agents.json
 *
 * This module provides:
 * - CRUD operations for agent programs
 * - Routing rules management
 * - Validation utilities
 *
 * @see shared/agent-programs.md for architecture documentation
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import type {
	AgentProgram,
	AgentRoutingRule,
	AgentConfigFile,
	AgentStatus,
	RoutingResult
} from '$lib/types/agentProgram';
import { createDefaultAgentConfig, isValidAgentId, getAgentModel } from '$lib/types/agentProgram';

// =============================================================================
// PATHS
// =============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'jat');
const AGENTS_CONFIG_FILE = join(CONFIG_DIR, 'agents.json');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');

// =============================================================================
// CONFIG DIR MANAGEMENT
// =============================================================================

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
}

// =============================================================================
// AGENT CONFIG FILE OPERATIONS
// =============================================================================

/**
 * Read the agent configuration file.
 * Returns default config if file doesn't exist or is invalid.
 */
export function getAgentConfig(): AgentConfigFile {
	ensureConfigDir();

	if (!existsSync(AGENTS_CONFIG_FILE)) {
		return createDefaultAgentConfig();
	}

	try {
		const content = readFileSync(AGENTS_CONFIG_FILE, 'utf-8');
		const config = JSON.parse(content) as AgentConfigFile;

		// Validate structure
		if (!config.version || !config.programs || !config.defaults) {
			console.warn('Invalid agent config structure, returning default');
			return createDefaultAgentConfig();
		}

		return config;
	} catch (error) {
		console.error('Error reading agent config file:', error);
		return createDefaultAgentConfig();
	}
}

/**
 * Save the agent configuration file.
 */
export function saveAgentConfig(config: AgentConfigFile): void {
	ensureConfigDir();

	config.updatedAt = new Date().toISOString();

	writeFileSync(AGENTS_CONFIG_FILE, JSON.stringify(config, null, 2), {
		encoding: 'utf-8',
		mode: 0o600
	});
}

// =============================================================================
// AGENT PROGRAM CRUD
// =============================================================================

/**
 * Get all agent programs.
 */
export function getAllAgentPrograms(): AgentProgram[] {
	const config = getAgentConfig();
	return Object.values(config.programs).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

/**
 * Get a single agent program by ID.
 */
export function getAgentProgram(id: string): AgentProgram | undefined {
	const config = getAgentConfig();
	return config.programs[id];
}

/**
 * Add a new agent program.
 * Returns the created program or throws if ID already exists.
 */
export function addAgentProgram(program: Omit<AgentProgram, 'createdAt' | 'updatedAt'>): AgentProgram {
	const config = getAgentConfig();

	if (!isValidAgentId(program.id)) {
		throw new Error(`Invalid agent ID: ${program.id}. Must be lowercase alphanumeric with hyphens.`);
	}

	if (config.programs[program.id]) {
		throw new Error(`Agent program with ID '${program.id}' already exists`);
	}

	const now = new Date().toISOString();
	const newProgram: AgentProgram = {
		...program,
		createdAt: now,
		updatedAt: now
	};

	config.programs[program.id] = newProgram;
	saveAgentConfig(config);

	return newProgram;
}

/**
 * Update an existing agent program.
 * Returns the updated program or throws if not found.
 */
export function updateAgentProgram(
	id: string,
	updates: Partial<Omit<AgentProgram, 'id' | 'createdAt'>>
): AgentProgram {
	const config = getAgentConfig();

	if (!config.programs[id]) {
		throw new Error(`Agent program '${id}' not found`);
	}

	const existing = config.programs[id];
	const updated: AgentProgram = {
		...existing,
		...updates,
		id: existing.id, // Cannot change ID
		createdAt: existing.createdAt, // Preserve creation time
		updatedAt: new Date().toISOString()
	};

	config.programs[id] = updated;
	saveAgentConfig(config);

	return updated;
}

/**
 * Delete an agent program.
 * Throws if the program doesn't exist or is the only/default one.
 */
export function deleteAgentProgram(id: string): void {
	const config = getAgentConfig();

	if (!config.programs[id]) {
		throw new Error(`Agent program '${id}' not found`);
	}

	// Cannot delete the default agent
	if (config.defaults.fallbackAgent === id) {
		throw new Error(`Cannot delete the default agent '${id}'. Set a different default first.`);
	}

	// Cannot delete the last agent
	if (Object.keys(config.programs).length === 1) {
		throw new Error('Cannot delete the only agent program. Add another agent first.');
	}

	// Remove from routing rules that reference this agent
	config.routingRules = config.routingRules.filter((rule) => rule.agentId !== id);

	delete config.programs[id];
	saveAgentConfig(config);
}

/**
 * Set an agent program as the default.
 */
export function setDefaultAgent(id: string, model?: string): void {
	const config = getAgentConfig();

	if (!config.programs[id]) {
		throw new Error(`Agent program '${id}' not found`);
	}

	const agent = config.programs[id];

	// Unset isDefault on all agents
	for (const agentId in config.programs) {
		config.programs[agentId].isDefault = agentId === id;
	}

	// Update defaults
	config.defaults.fallbackAgent = id;
	config.defaults.fallbackModel = model ?? agent.defaultModel;

	saveAgentConfig(config);
}

// =============================================================================
// ROUTING RULES CRUD
// =============================================================================

/**
 * Get all routing rules.
 */
export function getRoutingRules(): AgentRoutingRule[] {
	const config = getAgentConfig();
	return config.routingRules.sort((a, b) => a.order - b.order);
}

/**
 * Update all routing rules (replaces the entire list).
 */
export function updateRoutingRules(rules: AgentRoutingRule[]): void {
	const config = getAgentConfig();

	// Validate all agent IDs exist
	for (const rule of rules) {
		if (!config.programs[rule.agentId]) {
			throw new Error(`Routing rule '${rule.name}' references unknown agent '${rule.agentId}'`);
		}
	}

	// Ensure rules have unique IDs
	const ids = new Set<string>();
	for (const rule of rules) {
		if (ids.has(rule.id)) {
			throw new Error(`Duplicate routing rule ID: ${rule.id}`);
		}
		ids.add(rule.id);
	}

	// Update timestamps
	const now = new Date().toISOString();
	config.routingRules = rules.map((rule, index) => ({
		...rule,
		order: index,
		updatedAt: now,
		createdAt: rule.createdAt ?? now
	}));

	saveAgentConfig(config);
}

// =============================================================================
// AGENT STATUS CHECKING
// =============================================================================

/**
 * Check if a CLI command is available in PATH.
 */
export function isCommandAvailable(command: string): boolean {
	try {
		execSync(`which ${command}`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if an agent has authentication configured.
 */
export function isAuthConfigured(agent: AgentProgram): boolean {
	switch (agent.authType) {
		case 'none':
			return true;

		case 'subscription':
			// For subscription auth, check if the CLI is configured
			// Claude Code uses ~/.claude/.credentials.json
			if (agent.command === 'claude') {
				const claudeCredsFile = join(homedir(), '.claude', '.credentials.json');
				if (existsSync(claudeCredsFile)) {
					return true;
				}
				// Claude Code may store auth outside the credentials file (e.g., keychain).
				// Fall back to command availability to avoid false negatives.
				return isCommandAvailable(agent.command);
			}
			// For other subscription-based CLIs, assume configured if command exists
			return isCommandAvailable(agent.command);

		case 'api_key':
			// Check if API key is in credentials vault
			if (!agent.apiKeyProvider) {
				return false;
			}
			return hasApiKey(agent.apiKeyProvider);

		default:
			return false;
	}
}

// Path to OpenCode's auth file
const OPENCODE_AUTH_FILE = join(homedir(), '.local', 'share', 'opencode', 'auth.json');

// Path to Codex CLI's auth file
const CODEX_AUTH_FILE = join(homedir(), '.codex', 'auth.json');

// Path to Gemini CLI's auth/config file
const GEMINI_CLI_AUTH_FILE = join(homedir(), '.gemini', 'settings.json');

/**
 * Check if Codex CLI has valid authentication configured.
 * Codex uses auth stored in ~/.codex/auth.json or OPENAI_API_KEY env var.
 * The auth.json format is: { "OPENAI_API_KEY": "sk-..." }
 */
export function isCodexAuthConfigured(): { configured: boolean; hasApiKey: boolean; message?: string } {
	// Check if Codex auth file exists
	if (!existsSync(CODEX_AUTH_FILE)) {
		// Fall back to checking for OPENAI_API_KEY in credentials vault
		if (hasApiKey('openai')) {
			return {
				configured: true,
				hasApiKey: true
			};
		}
		return {
			configured: false,
			hasApiKey: false,
			message: 'Run "codex login" to authenticate or add OpenAI API key'
		};
	}

	try {
		const content = readFileSync(CODEX_AUTH_FILE, 'utf-8');
		const auth = JSON.parse(content);

		// Codex auth.json stores the API key as OPENAI_API_KEY
		// Format: { "OPENAI_API_KEY": "sk-..." }
		if (auth.OPENAI_API_KEY || auth.api_key || auth.access_token) {
			return {
				configured: true,
				hasApiKey: true
			};
		}

		// No valid auth found in file
		return {
			configured: false,
			hasApiKey: false,
			message: 'Codex auth file exists but is invalid. Run "codex login"'
		};
	} catch {
		return {
			configured: false,
			hasApiKey: false,
			message: 'Codex auth file is invalid. Run "codex login"'
		};
	}
}

/**
 * Check if OpenCode has valid authentication configured.
 * OpenCode uses OAuth auth stored in ~/.local/share/opencode/auth.json
 * OAuth takes precedence over API keys passed via environment.
 */
export function isOpenCodeAuthConfigured(provider: string): { configured: boolean; hasOAuth: boolean; message?: string } {
	// Check if OpenCode auth file exists
	if (!existsSync(OPENCODE_AUTH_FILE)) {
		return {
			configured: false,
			hasOAuth: false,
			message: 'Run "opencode auth login" to authenticate'
		};
	}

	try {
		const content = readFileSync(OPENCODE_AUTH_FILE, 'utf-8');
		const auth = JSON.parse(content);

		// Check if the requested provider has OAuth credentials
		const providerKey = provider.toLowerCase();
		if (auth[providerKey]) {
			return {
				configured: true,
				hasOAuth: true
			};
		}

		// Provider not in OAuth, but might work via API key env var
		return {
			configured: false,
			hasOAuth: false,
			message: `Run "opencode auth login" to authenticate with ${provider}`
		};
	} catch {
		return {
			configured: false,
			hasOAuth: false,
			message: 'OpenCode auth file is invalid. Run "opencode auth login"'
		};
	}
}

/**
 * Check if Gemini CLI has valid authentication configured.
 * Gemini CLI uses Google auth stored in ~/.gemini/settings.json
 * or GEMINI_API_KEY / GOOGLE_API_KEY environment variables.
 * @see https://geminicli.com/
 */
export function isGeminiCliAuthConfigured(): { configured: boolean; hasApiKey: boolean; message?: string } {
	// Check if Gemini CLI auth file exists
	if (existsSync(GEMINI_CLI_AUTH_FILE)) {
		try {
			const content = readFileSync(GEMINI_CLI_AUTH_FILE, 'utf-8');
			const settings = JSON.parse(content);

			// Check for API key in settings or OAuth tokens
			if (settings.api_key || settings.apiKey || settings.GEMINI_API_KEY || settings.access_token) {
				return {
					configured: true,
					hasApiKey: true
				};
			}
		} catch {
			// File exists but is invalid, continue to other checks
		}
	}

	// Fall back to checking for GEMINI_API_KEY or GOOGLE_API_KEY in credentials vault
	if (hasApiKey('google') || hasApiKey('gemini')) {
		return {
			configured: true,
			hasApiKey: true
		};
	}

	return {
		configured: false,
		hasApiKey: false,
		message: 'Run "gemini auth" to authenticate or add Google/Gemini API key'
	};
}

/**
 * Check if an API key exists in the credentials vault.
 */
export function hasApiKey(provider: string): boolean {
	if (!existsSync(CREDENTIALS_FILE)) {
		return false;
	}

	try {
		const content = readFileSync(CREDENTIALS_FILE, 'utf-8');
		const creds = JSON.parse(content);

		// Check standard API keys
		if (creds.apiKeys?.[provider]?.key) {
			return true;
		}

		// Check custom API keys
		if (creds.customApiKeys?.[provider]?.value) {
			return true;
		}

		return false;
	} catch {
		return false;
	}
}

/**
 * Get the status of an agent program.
 */
export function getAgentStatus(agent: AgentProgram): AgentStatus {
	const commandAvailable = isCommandAvailable(agent.command);

	// Special handling for agents with custom auth mechanisms
	let authConfigured: boolean;
	let statusMessage: string;

	if (agent.command === 'opencode') {
		// OpenCode uses OAuth auth via 'opencode auth login'
		const provider = agent.apiKeyProvider || 'anthropic';
		const openCodeAuth = isOpenCodeAuthConfigured(provider);

		authConfigured = openCodeAuth.configured;

		if (!agent.enabled) {
			statusMessage = 'Disabled';
		} else if (!commandAvailable) {
			statusMessage = `Command '${agent.command}' not found`;
		} else if (!authConfigured) {
			statusMessage = openCodeAuth.message || 'Run "opencode auth login" to authenticate';
		} else {
			statusMessage = 'Available';
		}
	} else if (agent.command === 'codex') {
		// Codex uses ~/.codex/auth.json or OPENAI_API_KEY
		const codexAuth = isCodexAuthConfigured();

		authConfigured = codexAuth.configured;

		if (!agent.enabled) {
			statusMessage = 'Disabled';
		} else if (!commandAvailable) {
			statusMessage = `Command '${agent.command}' not found`;
		} else if (!authConfigured) {
			statusMessage = codexAuth.message || 'Run "codex login" to authenticate';
		} else {
			statusMessage = 'Available';
		}
	} else if (agent.command === 'gemini') {
		// Gemini CLI uses ~/.gemini/settings.json or GEMINI_API_KEY
		const geminiAuth = isGeminiCliAuthConfigured();

		authConfigured = geminiAuth.configured;

		if (!agent.enabled) {
			statusMessage = 'Disabled';
		} else if (!commandAvailable) {
			statusMessage = `Command '${agent.command}' not found. Install via: npm install -g @google/gemini-cli`;
		} else if (!authConfigured) {
			statusMessage = geminiAuth.message || 'Run "gemini auth" to authenticate';
		} else {
			statusMessage = 'Available';
		}
	} else {
		authConfigured = isAuthConfigured(agent);

		if (!agent.enabled) {
			statusMessage = 'Disabled';
		} else if (!commandAvailable) {
			statusMessage = `Command '${agent.command}' not found`;
		} else if (!authConfigured) {
			if (agent.authType === 'api_key') {
				statusMessage = `API key not configured for ${agent.apiKeyProvider}`;
			} else {
				statusMessage = 'Authentication not configured';
			}
		} else {
			statusMessage = 'Available';
		}
	}

	const available = agent.enabled && commandAvailable && authConfigured;

	return {
		agentId: agent.id,
		enabled: agent.enabled,
		commandAvailable,
		authConfigured,
		available,
		statusMessage
	};
}

/**
 * Get status for all agent programs.
 */
export function getAllAgentStatuses(): AgentStatus[] {
	const programs = getAllAgentPrograms();
	return programs.map(getAgentStatus);
}

// =============================================================================
// ROUTING EVALUATION
// =============================================================================

interface TaskForRouting {
	id?: string;
	type?: string;
	labels?: string[];
	priority?: number;
	project?: string;
	epic?: string;
}

/**
 * Evaluate routing rules for a task.
 * Returns the agent and model to use, plus which rule matched.
 */
export function evaluateRouting(task: TaskForRouting): RoutingResult {
	const config = getAgentConfig();
	const rules = config.routingRules.filter((r) => r.enabled).sort((a, b) => a.order - b.order);

	// Check each rule in order
	for (const rule of rules) {
		if (ruleMatchesTask(rule, task)) {
			const agent = config.programs[rule.agentId];
			if (!agent || !agent.enabled) {
				continue; // Skip if agent doesn't exist or is disabled
			}

			const model = rule.modelOverride
				? getAgentModel(agent, rule.modelOverride) ?? getAgentModel(agent, agent.defaultModel)
				: getAgentModel(agent, agent.defaultModel);

			if (!model) {
				continue; // Skip if model not found
			}

			return {
				agent,
				model,
				matchedRule: rule,
				reason: `Matched rule: ${rule.name}`
			};
		}
	}

	// No rule matched, use fallback
	const fallbackAgent = config.programs[config.defaults.fallbackAgent];
	if (!fallbackAgent) {
		throw new Error(`Fallback agent '${config.defaults.fallbackAgent}' not found`);
	}

	const fallbackModel = getAgentModel(fallbackAgent, config.defaults.fallbackModel);
	if (!fallbackModel) {
		throw new Error(`Fallback model '${config.defaults.fallbackModel}' not found`);
	}

	return {
		agent: fallbackAgent,
		model: fallbackModel,
		matchedRule: null,
		reason: 'No rules matched, using fallback agent'
	};
}

/**
 * Check if a routing rule matches a task.
 */
function ruleMatchesTask(rule: AgentRoutingRule, task: TaskForRouting): boolean {
	// Empty conditions = matches all tasks
	if (rule.conditions.length === 0) {
		return true;
	}

	// All conditions must match (AND logic)
	return rule.conditions.every((condition) => {
		const operator = condition.operator ?? 'equals';
		const conditionValue = condition.value;

		switch (condition.type) {
			case 'label': {
				const labels = task.labels ?? [];
				switch (operator) {
					case 'contains':
						return labels.some((l) => l.toLowerCase().includes(conditionValue.toLowerCase()));
					case 'equals':
						return labels.some((l) => l.toLowerCase() === conditionValue.toLowerCase());
					case 'startsWith':
						return labels.some((l) => l.toLowerCase().startsWith(conditionValue.toLowerCase()));
					case 'regex':
						try {
							const re = new RegExp(conditionValue, 'i');
							return labels.some((l) => re.test(l));
						} catch {
							return false;
						}
					default:
						return false;
				}
			}

			case 'type': {
				const taskType = task.type?.toLowerCase() ?? '';
				switch (operator) {
					case 'equals':
						return taskType === conditionValue.toLowerCase();
					case 'contains':
						return taskType.includes(conditionValue.toLowerCase());
					case 'regex':
						try {
							return new RegExp(conditionValue, 'i').test(taskType);
						} catch {
							return false;
						}
					default:
						return false;
				}
			}

			case 'priority': {
				const priority = task.priority ?? 3;
				const targetPriority = parseInt(conditionValue, 10);
				if (isNaN(targetPriority)) return false;

				switch (operator) {
					case 'equals':
						return priority === targetPriority;
					case 'lt':
						return priority < targetPriority;
					case 'lte':
						return priority <= targetPriority;
					case 'gt':
						return priority > targetPriority;
					case 'gte':
						return priority >= targetPriority;
					default:
						return false;
				}
			}

			case 'project': {
				const project = task.project?.toLowerCase() ?? '';
				switch (operator) {
					case 'equals':
						return project === conditionValue.toLowerCase();
					case 'contains':
						return project.includes(conditionValue.toLowerCase());
					case 'startsWith':
						return project.startsWith(conditionValue.toLowerCase());
					case 'regex':
						try {
							return new RegExp(conditionValue, 'i').test(project);
						} catch {
							return false;
						}
					default:
						return false;
				}
			}

			case 'epic': {
				const epic = task.epic?.toLowerCase() ?? '';
				switch (operator) {
					case 'equals':
						return epic === conditionValue.toLowerCase();
					case 'contains':
						return epic.includes(conditionValue.toLowerCase());
					case 'startsWith':
						return epic.startsWith(conditionValue.toLowerCase());
					case 'regex':
						try {
							return new RegExp(conditionValue, 'i').test(epic);
						} catch {
							return false;
						}
					default:
						return false;
				}
			}

			default:
				return false;
		}
	});
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate an agent program object.
 */
export function validateAgentProgram(
	program: Partial<AgentProgram>
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!program.id) {
		errors.push('ID is required');
	} else if (!isValidAgentId(program.id)) {
		errors.push('ID must be lowercase alphanumeric with hyphens, starting with a letter');
	}

	if (!program.name || program.name.trim().length === 0) {
		errors.push('Name is required');
	}

	if (!program.command || program.command.trim().length === 0) {
		errors.push('Command is required');
	}

	if (!program.models || program.models.length === 0) {
		errors.push('At least one model is required');
	}

	if (!program.defaultModel) {
		errors.push('Default model is required');
	} else if (program.models && !program.models.some((m) => m.shortName === program.defaultModel)) {
		errors.push(`Default model '${program.defaultModel}' not found in models list`);
	}

	if (!program.authType) {
		errors.push('Auth type is required');
	} else if (!['subscription', 'api_key', 'none'].includes(program.authType)) {
		errors.push('Auth type must be subscription, api_key, or none');
	}

	if (program.authType === 'api_key' && !program.apiKeyProvider) {
		errors.push('API key provider is required when auth type is api_key');
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Validate a routing rule object.
 */
export function validateRoutingRule(
	rule: Partial<AgentRoutingRule>
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!rule.id) {
		errors.push('ID is required');
	}

	if (!rule.name || rule.name.trim().length === 0) {
		errors.push('Name is required');
	}

	if (!rule.agentId) {
		errors.push('Agent ID is required');
	}

	if (!Array.isArray(rule.conditions)) {
		errors.push('Conditions must be an array');
	}

	if (typeof rule.enabled !== 'boolean') {
		errors.push('Enabled must be a boolean');
	}

	return { valid: errors.length === 0, errors };
}
