/**
 * Work Spawn API - Auto-spawn agent + session
 * POST /api/work/spawn
 *
 * Creates a NEW agent + tmux session:
 * 1. Evaluate routing rules (or use explicit agentId/model)
 * 2. Validate agent is enabled and auth is available
 * 3. Generate agent name and register in Agent Mail
 * 4. Create tmux session jat-{AgentName}
 * 5. If taskId provided: Assign task to agent in Beads (bd update)
 * 6. Run agent CLI with /jat:start (with agent name, optionally with task)
 * 7. Return new WorkSession with agent selection info
 *
 * Body:
 * - taskId: Task ID to assign (optional - if omitted, creates planning session)
 * - agentId: Agent program to use (optional - if omitted, uses routing rules or fallback)
 * - model: Model to use (optional - if omitted, uses agent default or routing rule override)
 * - attach: If true, immediately open terminal attached to session (default: false)
 * - project: Project name or path (optional - inferred from taskId if not provided)
 * - imagePath: Path to image to send after startup (optional)
 */

import { json } from '@sveltejs/kit';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import {
	DEFAULT_MODEL,
	AGENT_MAIL_URL,
	CLAUDE_STARTUP_TIMEOUT_SECONDS
} from '$lib/config/spawnConfig.js';
import { getTaskById } from '$lib/server/beads.js';
import { getProjectPath, getJatDefaults } from '$lib/server/projectPaths.js';
import { CLAUDE_READY_PATTERNS, SHELL_PROMPT_PATTERNS, isYoloWarningDialog, getReadyPatternsForAgent } from '$lib/server/shellPatterns.js';
import { stripAnsi } from '$lib/utils/ansiToHtml.js';
import {
	evaluateRouting,
	getAgentProgram,
	getAgentStatus,
	getAgentConfig
} from '$lib/utils/agentConfig.js';
import { getAgentModel } from '$lib/types/agentProgram.js';
import { getApiKey, getCustomApiKey, getCustomApiKeyMeta } from '$lib/utils/credentials.js';

const DB_PATH = process.env.AGENT_MAIL_DB || `${process.env.HOME}/.agent-mail.db`;

// Name components - nature/geography themed words
// 72 adjectives × 72 nouns = 5,184 unique combinations
const ADJECTIVES = [
	// Temperature/Texture (16)
	'Swift', 'Calm', 'Warm', 'Cool', 'Soft', 'Hard', 'Smooth', 'Rough',
	'Sharp', 'Dense', 'Thin', 'Thick', 'Crisp', 'Mild', 'Brisk', 'Gentle',
	// Light/Color (16)
	'Bright', 'Dark', 'Light', 'Pale', 'Vivid', 'Muted', 'Stark', 'Dim',
	'Gold', 'Silver', 'Azure', 'Amber', 'Russet', 'Ivory', 'Jade', 'Coral',
	// Size/Scale (16)
	'Grand', 'Great', 'Vast', 'Wide', 'Broad', 'Deep', 'High', 'Tall',
	'Long', 'Far', 'Near', 'Open', 'Steep', 'Sheer', 'Flat', 'Round',
	// Quality/Character (16)
	'Bold', 'Keen', 'Wise', 'Fair', 'True', 'Pure', 'Free', 'Wild',
	'Clear', 'Fresh', 'Fine', 'Good', 'Rich', 'Full', 'Whole', 'Prime',
	// Weather/Time (8)
	'Sunny', 'Misty', 'Windy', 'Rainy', 'Early', 'Late', 'First', 'Last'
];

const NOUNS = [
	// Water Bodies (16)
	'River', 'Ocean', 'Lake', 'Stream', 'Creek', 'Brook', 'Pond', 'Falls',
	'Bay', 'Cove', 'Gulf', 'Inlet', 'Fjord', 'Strait', 'Marsh', 'Spring',
	// Land Features (16)
	'Mountain', 'Valley', 'Canyon', 'Gorge', 'Ravine', 'Basin', 'Plateau', 'Mesa',
	'Hill', 'Ridge', 'Cliff', 'Bluff', 'Ledge', 'Shelf', 'Slope', 'Terrace',
	// Vegetation (16)
	'Forest', 'Woods', 'Grove', 'Glade', 'Thicket', 'Copse', 'Orchard', 'Garden',
	'Prairie', 'Meadow', 'Field', 'Plain', 'Heath', 'Moor', 'Steppe', 'Savanna',
	// Coastal (8)
	'Shore', 'Coast', 'Beach', 'Dune', 'Cape', 'Point', 'Isle', 'Reef',
	// Atmospheric (8)
	'Cloud', 'Storm', 'Wind', 'Mist', 'Frost', 'Dawn', 'Dusk', 'Horizon',
	// Geological (8)
	'Stone', 'Rock', 'Boulder', 'Pebble', 'Sand', 'Clay', 'Slate', 'Granite'
];

/**
 * Resolve a project input that might be a path or a name.
 * Returns a filesystem path if the input looks like a path, otherwise null.
 * @param {string} value
 * @returns {string|null}
 */
function resolveProjectInput(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;

	const isPathLike =
		trimmed.includes('/') ||
		trimmed.startsWith('~') ||
		trimmed.startsWith('./') ||
		trimmed.startsWith('../');

	if (!isPathLike) return null;

	const expanded = trimmed.startsWith('~')
		? `${homedir()}${trimmed.slice(1)}`
		: trimmed;

	return resolve(expanded);
}

/**
 * Escape a string for safe use in shell commands (single-quoted).
 * @param {string} str
 * @returns {string}
 */
function shellEscape(str) {
	if (!str) return "''";
	return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Get existing agent names from database for collision checking
 * @returns {Set<string>} Set of existing agent names (lowercase)
 */
function getExistingAgentNames() {
	try {
		const db = new Database(DB_PATH, { readonly: true });
		const agents = /** @type {{ name: string }[]} */ (
			db.prepare('SELECT name FROM agents').all()
		);
		db.close();
		return new Set(agents.map(a => a.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

/**
 * Generate a unique agent name
 * @param {Set<string>} existingNames - Set of existing agent names (lowercase)
 * @param {number} maxAttempts - Maximum generation attempts
 * @returns {string} A unique agent name
 */
function generateUniqueName(existingNames, maxAttempts = 100) {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
		const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
		const name = adj + noun;

		if (!existingNames.has(name.toLowerCase())) {
			return name;
		}
	}

	// Fallback: append random suffix
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	const suffix = Math.floor(Math.random() * 1000);
	return `${adj}${noun}${suffix}`;
}

/**
 * Get or create project in Agent Mail database
 * @param {import('better-sqlite3').Database} db - Database connection
 * @param {string} projectPath - Full project path
 * @returns {number} Project ID
 */
function getOrCreateProject(db, projectPath) {
	// Use project name as slug (last segment of path)
	const slug = projectPath.split('/').filter(Boolean).pop() || 'unknown';

	// Check if project exists
	const existing = /** @type {{ id: number } | undefined} */ (
		db.prepare('SELECT id FROM projects WHERE human_key = ?').get(projectPath)
	);
	if (existing) {
		return existing.id;
	}

	// Create project
	const result = db.prepare(
		'INSERT INTO projects (slug, human_key) VALUES (?, ?)'
	).run(slug, projectPath);

	return /** @type {number} */ (result.lastInsertRowid);
}

/**
 * Register agent in Agent Mail database
 * @param {string} agentName - Agent name
 * @param {string} projectPath - Project path
 * @param {string} model - Model name (e.g., "opus", "sonnet")
 * @param {string} program - Agent program ID (e.g., "claude-code", "codex-cli")
 * @returns {{ success: boolean, agentId?: number, error?: string }}
 */
function registerAgentInDb(agentName, projectPath, model, program = 'claude-code') {
	try {
		const db = new Database(DB_PATH);

		try {
			const projectId = getOrCreateProject(db, projectPath);

			// Check if agent already exists for this project
			const existing = /** @type {{ id: number } | undefined} */ (
				db.prepare(
					'SELECT id FROM agents WHERE project_id = ? AND name = ?'
				).get(projectId, agentName)
			);

			if (existing) {
				// Update last_active_ts, model, and program for existing agent
				db.prepare(
					"UPDATE agents SET last_active_ts = datetime('now'), model = ?, program = ? WHERE id = ?"
				).run(model, program, existing.id);
				return { success: true, agentId: existing.id };
			}

			// Insert new agent with selected program
			const result = db.prepare(`
				INSERT INTO agents (project_id, name, program, model, task_description)
				VALUES (?, ?, ?, ?, '')
			`).run(projectId, agentName, program, model);

			return { success: true, agentId: /** @type {number} */ (result.lastInsertRowid) };
		} finally {
			db.close();
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

const execAsync = promisify(exec);

/**
 * @typedef {Object} TaskForRouting
 * @property {string} id
 * @property {string} [issue_type]
 * @property {string[]} [labels]
 * @property {number} [priority]
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [status]
 */

/**
 * Select agent and model based on request parameters and routing rules.
 *
 * @param {object} params
 * @param {string | undefined} params.agentId - Explicit agent ID (optional)
 * @param {string | undefined} params.model - Explicit model shortName (optional)
 * @param {TaskForRouting | null} params.task - Task object for routing evaluation
 * @returns {{ agent: import('$lib/types/agentProgram.js').AgentProgram, model: import('$lib/types/agentProgram.js').AgentModel, matchedRule: import('$lib/types/agentProgram.js').AgentRoutingRule | null, reason: string } | { error: string, status: number }}
 */
function selectAgentAndModel({ agentId, model, task }) {
	const config = getAgentConfig();

	// If explicit agentId provided, use it
	if (agentId) {
		const agent = getAgentProgram(agentId);
		if (!agent) {
			return { error: `Agent program '${agentId}' not found`, status: 400 };
		}

		// Check agent is enabled
		const status = getAgentStatus(agent);
		if (!status.available) {
			return {
				error: `Agent '${agentId}' is not available: ${status.statusMessage}`,
				status: 400
			};
		}

		// Get the model (explicit or default)
		const modelShortName = model || agent.defaultModel;
		const selectedModel = getAgentModel(agent, modelShortName);
		if (!selectedModel) {
			return {
				error: `Model '${modelShortName}' not found for agent '${agentId}'`,
				status: 400
			};
		}

		return {
			agent,
			model: selectedModel,
			matchedRule: null,
			reason: `Explicit selection: ${agent.name} with ${selectedModel.name}`
		};
	}

	// No explicit agent - evaluate routing rules
	// Build task object for routing evaluation
	const taskForRouting = task
		? {
				id: task.id,
				type: task.issue_type,
				labels: task.labels || [],
				priority: task.priority,
				project: task.id?.split('-')[0] // Extract project from task ID prefix
			}
		: null;

	if (taskForRouting) {
		try {
			const routingResult = evaluateRouting(taskForRouting);

			// If explicit model override provided, use it instead of routing result
			if (model) {
				const overrideModel = getAgentModel(routingResult.agent, model);
				if (overrideModel) {
					return {
						agent: routingResult.agent,
						model: overrideModel,
						matchedRule: routingResult.matchedRule,
						reason: `${routingResult.reason} (model overridden to ${overrideModel.name})`
					};
				}
			}

			// Check agent is available
			const status = getAgentStatus(routingResult.agent);
			if (!status.available) {
				// Fall through to fallback agent
				console.warn(
					`[spawn] Routing selected ${routingResult.agent.id} but it's unavailable: ${status.statusMessage}`
				);
			} else {
				return routingResult;
			}
		} catch (err) {
			console.warn('[spawn] Routing evaluation failed:', err);
		}
	}

	// Use fallback agent
	const fallbackAgent = config.programs[config.defaults.fallbackAgent];
	if (!fallbackAgent) {
		return {
			error: `Fallback agent '${config.defaults.fallbackAgent}' not configured`,
			status: 500
		};
	}

	// Check fallback is available
	const fallbackStatus = getAgentStatus(fallbackAgent);
	if (!fallbackStatus.available) {
		return {
			error: `Fallback agent '${fallbackAgent.id}' is not available: ${fallbackStatus.statusMessage}`,
			status: 500
		};
	}

	// Get model (explicit override or configured fallback)
	const fallbackModelName = model || config.defaults.fallbackModel;
	const fallbackModel = getAgentModel(fallbackAgent, fallbackModelName);
	if (!fallbackModel) {
		return {
			error: `Fallback model '${fallbackModelName}' not found for agent '${fallbackAgent.id}'`,
			status: 500
		};
	}

	return {
		agent: fallbackAgent,
		model: fallbackModel,
		matchedRule: null,
		reason: 'Using fallback agent (no routing rules matched)'
	};
}

/**
 * @typedef {Object} JatDefaults
 * @property {boolean} [skip_permissions]
 * @property {number} [claude_startup_timeout]
 * @property {string} [model]
 * @property {number} [agent_stagger]
 */

/**
 * Build the CLI command for starting an agent session.
 *
 * @param {object} params
 * @param {import('$lib/types/agentProgram.js').AgentProgram} params.agent
 * @param {import('$lib/types/agentProgram.js').AgentModel} params.model
 * @param {string} params.projectPath
 * @param {JatDefaults} params.jatDefaults
 * @param {string} [params.agentName] - Agent name for task injection
 * @param {string} [params.taskId] - Task ID for task injection
 * @param {string} [params.taskTitle] - Task title for task injection
 * @returns {{ command: string, env: Record<string, string>, needsJatStart: boolean }}
 */
function buildAgentCommand({ agent, model, projectPath, jatDefaults, agentName, taskId, taskTitle, mode }) {
	// Build environment variables
	/** @type {Record<string, string>} */
	const env = { AGENT_MAIL_URL };

	// For API key auth, inject the key as environment variable
	if (agent.authType === 'api_key' && agent.apiKeyEnvVar && agent.apiKeyProvider) {
		// Try built-in providers first
		let apiKey = getApiKey(agent.apiKeyProvider);

		// Try custom API keys
		if (!apiKey) {
			apiKey = getCustomApiKey(agent.apiKeyProvider);
		}

		if (apiKey) {
			env[agent.apiKeyEnvVar] = apiKey;
		}
	}

	// Build command based on agent configuration
	// Default pattern: {command} --model {model} {flags}
	let cmdParts = [`cd ${shellEscape(projectPath)}`];

	// Add environment variables
	for (const [key, value] of Object.entries(env)) {
		cmdParts.push(`${key}=${shellEscape(value)}`);
	}

	// Use custom startup pattern if defined, otherwise build default
	if (agent.startupPattern) {
		// Replace placeholders in custom pattern
		let customCmd = agent.startupPattern
			.replace('{command}', agent.command)
			.replace('{model}', model.id)
			.replace('{flags}', agent.flags.join(' '));

		cmdParts.push(customCmd);
	} else {
		// Default command construction
		let agentCmd = agent.command;

		// Add model flag (agent-specific)
		if (agent.command === 'claude') {
			agentCmd += ` --model ${model.shortName}`;
		} else if (agent.command === 'codex' || agent.command === 'gemini') {
			agentCmd += ` --model ${model.id}`;
		} else if (agent.command === 'opencode') {
			// OpenCode uses provider/model format (e.g., anthropic/claude-sonnet-4-20250514)
			const provider = agent.apiKeyProvider || 'anthropic';
			agentCmd += ` --model ${provider}/${model.id}`;
		} else {
			// Generic: try --model with full ID
			agentCmd += ` --model ${model.id}`;
		}

		// Add configured flags
		if (agent.flags && agent.flags.length > 0) {
			agentCmd += ' ' + agent.flags.join(' ');
		}

		// For Claude Code specifically, handle skip_permissions from JAT config
		if (agent.command === 'claude' && jatDefaults.skip_permissions) {
			// Only add if not already in flags
			if (!agent.flags.includes('--dangerously-skip-permissions')) {
				agentCmd += ' --dangerously-skip-permissions';
			}
		}

		// Handle task injection based on agent configuration
		// taskInjection modes:
		// - 'stdin' (default for Claude Code): Send /jat:start command after agent starts
		// - 'prompt': Pass initial prompt via --prompt flag (e.g., OpenCode)
		// - 'argument': Pass as positional command argument (e.g., Codex)
		const taskInjectionMode = agent.taskInjection || 'stdin';

		if (agent.command === 'claude') {
			// Claude Code uses JAT bootstrap + /jat:start after startup
			const projName = projectPath.split('/').filter(Boolean).pop() || 'project';
			const jatBootstrap = mode === 'plan'
				? `You are a planning assistant for the ${projName} project. Help the user plan features, discuss architecture, and think through requirements. When the user is ready to create tasks, they can use /jat:tasktree. Do NOT run /jat:start.`
				: `You are a JAT agent. Run /jat:start to begin work.`;
			agentCmd += ` --append-system-prompt '${jatBootstrap}'`;
		} else if (taskInjectionMode === 'argument' && (agentName || taskId)) {
			// Agents with argument injection (like Codex) - pass task as positional argument
			const promptParts = [];
			promptParts.push('You are a JAT agent working on a software development task.');
			if (taskId) {
				promptParts.push(`Task ID: ${taskId}`);
			}
			if (taskTitle) {
				promptParts.push(`Task: ${taskTitle}`);
			}
			if (agentName) {
				promptParts.push(`Your agent name is: ${agentName}`);
			}
			promptParts.push('Read the CLAUDE.md file in the project root for JAT workflow instructions.');
			promptParts.push('Start by understanding the task and implementing it.');

			const prompt = promptParts.join(' ');
			// Escape double quotes for shell argument
			const escapedPrompt = prompt.replace(/"/g, '\\"');
			agentCmd += ` "${escapedPrompt}"`;
		} else if (taskInjectionMode === 'prompt' && (agentName || taskId)) {
			// Agents with prompt injection (like OpenCode) - pass task via --prompt
			const promptParts = [];
			promptParts.push('You are a JAT agent working on a software development task.');
			if (taskId) {
				promptParts.push(`Task ID: ${taskId}`);
			}
			if (taskTitle) {
				promptParts.push(`Task: ${taskTitle}`);
			}
			if (agentName) {
				promptParts.push(`Your agent name is: ${agentName}`);
			}
			promptParts.push('Read the CLAUDE.md file in the project root for JAT workflow instructions.');
			promptParts.push('Start by understanding the task and implementing it.');

			const prompt = promptParts.join(' ');
			// Escape single quotes in prompt
			const escapedPrompt = prompt.replace(/'/g, "'\\''");
			agentCmd += ` --prompt '${escapedPrompt}'`;
		}

		cmdParts.push(agentCmd);
	}

	// Determine if we need to send /jat:start after the agent starts
	// Claude Code: yes (uses /jat:start slash command)
	// OpenCode with prompt injection: no (task already passed via --prompt)
	const taskInjectionMode = agent.taskInjection || 'stdin';
	const needsJatStart = mode !== 'plan' && (agent.command === 'claude' || taskInjectionMode === 'stdin');

	return {
		command: cmdParts.join(' && '),
		env,
		needsJatStart
	};
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	try {
		const body = await request.json();
		const {
			taskId,
			agentId = null,
			model = null,
			attach = false,
			imagePath = null,
			project = null,
			mode = 'task'
		} = body;
		const explicitProjectProvided =
			project !== null && project !== undefined && String(project).trim() !== '';

		// agentId is optional - if omitted, uses routing rules or fallback
		// model is optional - if omitted, uses agent default or routing rule override
		// taskId is optional - if not provided, creates a planning session
		// imagePath is optional - if provided, will be sent to the session after startup
		// project is optional - if provided, use name or path; otherwise infer from task ID prefix

		// Determine project path:
		// 1. If explicit project provided, look it up in JAT config
		// 2. If taskId provided, infer from prefix and look up in JAT config
		// 3. Fall back to current project (jat)
		let projectPath = null;
		let inferredFromTaskId = false;

		if (explicitProjectProvided) {
			// Explicit project provided - may be a name or a path
			const projectInput = String(project);
			const explicitPath = resolveProjectInput(projectInput);
			if (explicitPath) {
				projectPath = explicitPath;
			} else {
				// Look up project path from JAT config (supports custom paths)
				const projectInfo = await getProjectPath(projectInput);
				if (projectInfo.exists) {
					projectPath = projectInfo.path;
				}
			}
		}

		if (explicitProjectProvided && !projectPath) {
			return json({
				error: 'Project not found',
				message: `Project '${String(project)}' not found in JAT config`,
				project: String(project)
			}, { status: 400 });
		}

		if (!projectPath && taskId) {
			// Task IDs follow format: {project}-{hash}
			// Handle underscores in project names (e.g., "Community_Connect-abc")
			const lastDashIndex = taskId.lastIndexOf('-');
			const taskPrefix = lastDashIndex > 0 ? taskId.substring(0, lastDashIndex) : taskId.split('-')[0];

			if (taskPrefix && taskPrefix.toLowerCase() !== 'jat') {
				// Look up project path from JAT config (supports custom paths)
				const projectInfo = await getProjectPath(taskPrefix);
				if (projectInfo.exists) {
					projectPath = projectInfo.path;
					inferredFromTaskId = true;
				} else {
					console.warn(`[spawn] Project ${taskPrefix} not found at ${projectInfo.path}, falling back to current project`);
				}
			}
		}

		// Fall back to current project (jat) if no valid path determined
		projectPath = projectPath || process.cwd().replace('/ide', '');

		// Final validation: ensure project path exists
		if (!existsSync(projectPath)) {
			return json({
				error: 'Project path not found',
				message: `Project directory does not exist: ${projectPath}`,
				taskId
			}, { status: 400 });
		}

		// Validate beads database exists in project
		const beadsPath = `${projectPath}/.beads`;
		if (!existsSync(beadsPath)) {
			return json({
				error: 'Beads database not found',
				message: `No .beads directory found in ${projectPath}. Run 'bd init' to initialize.`,
				projectPath,
				taskId
			}, { status: 400 });
		}

		console.log('[spawn] Project path:', projectPath, inferredFromTaskId ? '(inferred from task ID)' : '');

		// Extract project name from path early (needed for signal and response)
		// e.g., "/home/jw/code/jat" -> "jat"
		const projectName = projectPath.split('/').filter(Boolean).pop() || null;

		// Get JAT config defaults (used for skip_permissions, timeout, etc.)
		const jatDefaults = await getJatDefaults();

		// Step 0: Fetch task data early (needed for routing rule evaluation)
		let task = null;
		if (taskId) {
			try {
				task = getTaskById(taskId);
			} catch (err) {
				console.warn(`[spawn] Could not fetch task ${taskId} for routing:`, err);
			}
		}

		// Step 0b: Select agent and model based on routing rules or explicit params
		const agentSelection = selectAgentAndModel({ agentId, model, task });
		if ('error' in agentSelection) {
			return json({
				error: agentSelection.error
			}, { status: agentSelection.status });
		}

		const { agent: selectedAgent, model: selectedModel, matchedRule, reason: selectionReason } = agentSelection;
		console.log(`[spawn] Agent selection: ${selectedAgent.name} (${selectedModel.name}) - ${selectionReason}`);

		// Step 1: Generate unique agent name and register in Agent Mail database
		const existingNames = getExistingAgentNames();
		const agentName = generateUniqueName(existingNames);

		// Register agent in Agent Mail SQLite database
		// Use selected model's shortName and agent program ID for storage
		const registerResult = registerAgentInDb(agentName, projectPath, selectedModel.shortName, selectedAgent.id);
		if (!registerResult.success) {
			console.error('Failed to register agent:', registerResult.error);
			return json({
				error: 'Failed to register agent',
				message: registerResult.error
			}, { status: 500 });
		}
		console.log(`[spawn] Registered agent ${agentName} in Agent Mail database (id: ${registerResult.agentId})`)

		// Step 2: Assign task to new agent in Beads (if taskId provided)
		if (taskId) {
			try {
				await execAsync(`bd update "${taskId}" --status in_progress --assignee "${agentName}"`, {
					cwd: projectPath,
					timeout: 10000
				});
				console.log(`[spawn] Assigned task ${taskId} to ${agentName} in ${projectPath}`);
			} catch (err) {
				// Provide detailed error context for debugging
				const execErr = /** @type {{ stderr?: string, stdout?: string, message?: string }} */ (err);
				const errorDetail = execErr.stderr || execErr.stdout || (err instanceof Error ? err.message : String(err));

				console.error(`[spawn] Failed to assign task ${taskId}:`, {
					error: errorDetail,
					projectPath,
					agentName
				});

				return json({
					error: 'Failed to assign task',
					message: errorDetail,
					detail: `Task ${taskId} may not exist in ${projectPath}/.beads`,
					agentName,
					taskId,
					projectPath
				}, { status: 500 });
			}
		}

		// Step 3: Create tmux session with Claude Code
		const sessionName = `jat-${agentName}`;

		// Step 3a: Write agent identity file for session-start hook to restore
		// The hook (session-start-restore-agent.sh) uses this to set up .claude/sessions/agent-{sessionId}.txt
		// We use tmux session name as the key since that's known before Claude starts
		try {
			const sessionsDir = `${projectPath}/.claude/sessions`;
			mkdirSync(sessionsDir, { recursive: true });

			// Write a file that maps tmux session name to agent name
			// The hook can look this up using: tmux display-message -p '#S' to get session name
			const tmuxAgentFile = `${sessionsDir}/.tmux-agent-${sessionName}`;
			writeFileSync(tmuxAgentFile, agentName, 'utf-8');
			console.log(`[spawn] Wrote agent identity file: ${tmuxAgentFile}`);
		} catch (err) {
			// Non-fatal - hook will still work through other mechanisms
			console.warn('[spawn] Failed to write agent identity file:', err);
		}

		// Default tmux dimensions for proper terminal output width
		// 80 columns is the standard terminal width that Claude Code expects
		// 40 rows provides good vertical context for terminal output
		const TMUX_INITIAL_WIDTH = 80;
		const TMUX_INITIAL_HEIGHT = 40;

		// Build the agent command dynamically based on selected agent program
		const { command: agentCmd, needsJatStart } = buildAgentCommand({
			agent: selectedAgent,
			model: selectedModel,
			projectPath,
			jatDefaults,
			agentName,
			taskId,
			taskTitle: task?.title,
			mode
		});

		console.log(`[spawn] Agent command: ${agentCmd.substring(0, 100)}...`);
		console.log(`[spawn] needsJatStart: ${needsJatStart}`);

		// Create session with explicit dimensions to ensure proper terminal width from the start
		// Without -x and -y, tmux uses default 80x24 which may not match IDE card width
		// Use sleep to allow shell to initialize before sending keys - without this delay,
		// the shell may not be ready and keys are lost (race condition)
		const escapedSessionName = shellEscape(sessionName);
		const escapedProjectPath = shellEscape(projectPath);
		const escapedAgentCmd = shellEscape(agentCmd);

		const createSessionCmd = `tmux new-session -d -s ${escapedSessionName} -x ${TMUX_INITIAL_WIDTH} -y ${TMUX_INITIAL_HEIGHT} -c ${escapedProjectPath} && sleep 0.3 && tmux send-keys -t ${escapedSessionName} ${escapedAgentCmd} Enter`;

		try {
			await execAsync(createSessionCmd);
		} catch (err) {
			const execErr = /** @type {{ stderr?: string, message?: string }} */ (err);
			const errorMessage = execErr.stderr || (err instanceof Error ? err.message : String(err));

			// If session already exists, that's a conflict
			if (errorMessage.includes('duplicate session')) {
				return json({
					error: 'Session already exists',
					message: `Session '${sessionName}' already exists`,
					sessionName,
					agentName
				}, { status: 409 });
			}

			return json({
				error: 'Failed to create session',
				message: errorMessage,
				sessionName,
				agentName
			}, { status: 500 });
		}

		// Write IDE-initiated signal for instant UI feedback
		// For plan mode, write 'planning' state; otherwise write 'starting'
		try {
			const signalType = mode === 'plan' ? 'planning' : 'starting';
			const startingSignal = {
				type: signalType,
				agentName,
				sessionId: sessionName,
				project: projectName,
				model: selectedModel.shortName,
				agentProgram: selectedAgent.id,
				taskId: taskId || null,
				taskTitle: task?.title || null,
				timestamp: new Date().toISOString()
			};
			const signalFile = `/tmp/jat-signal-tmux-${sessionName}.json`;
			writeFileSync(signalFile, JSON.stringify(startingSignal, null, 2), 'utf-8');
			console.log(`[spawn] Wrote IDE-initiated ${signalType} signal: ${signalFile}`);
		} catch (err) {
			// Non-fatal - UI will eventually get state from agent
			console.warn('[spawn] Failed to write starting signal:', err);
		}

		// Step 4: Wait for Claude to initialize, then send /jat:start {agentName} [taskId]
		// Pass the agent name explicitly so /jat:start resumes the existing agent
		// instead of creating a new one with a different name
		// If taskId provided, include BOTH agent name and task ID so the agent:
		// 1. Uses the pre-created agent name (no duplicate creation)
		// 2. Starts working on the specific task immediately
		const initialPrompt = taskId
			? `/jat:start ${agentName} ${taskId}`  // Agent name + task (prevents duplicate agent)
			: `/jat:start ${agentName}`;  // Planning mode - just register agent

		// Wait for agent to initialize with verification
		// Check that agent TUI is running (not just bash prompt)
		const maxWaitSeconds = jatDefaults.claude_startup_timeout || 20;
		const checkIntervalMs = 500;
		let agentReady = false;
		let shellPromptDetected = false;
		for (let waited = 0; waited < maxWaitSeconds * 1000 && !agentReady; waited += checkIntervalMs) {
			await new Promise(resolve => setTimeout(resolve, checkIntervalMs));

			try {
				const { stdout: paneOutput } = await execAsync(
					`tmux capture-pane -t "${sessionName}" -p 2>/dev/null`
				);

				// Check for YOLO warning dialog (first-time --dangerously-skip-permissions)
				// This dialog blocks startup and expects user to select "1" (No) or "2" (Yes)
				// We do NOT auto-accept for liability reasons - user must read and accept themselves
				if (isYoloWarningDialog(paneOutput)) {
					console.log(`[spawn] YOLO permission warning detected - waiting for user to accept in terminal...`);
					// Return error so IDE can notify user to accept manually
					return json({
						error: 'Permission warning requires user acceptance',
						code: 'YOLO_WARNING_PENDING',
						message: 'Claude Code is showing a permissions warning dialog. Please open the terminal and accept it to continue.',
						sessionName,
						agentName,
						recoveryHint: `Run: tmux attach-session -t ${sessionName}`
					}, { status: 202 }); // 202 Accepted - request received but needs user action
				}

				// Check if agent is running (has agent-specific ready patterns)
				const readyPatterns = getReadyPatternsForAgent(selectedAgent.command);
				const hasAgentPatterns = readyPatterns.some(p => paneOutput.includes(p));

				// Check if we're at a shell prompt (agent never started or exited)
				// Only flag as shell prompt if:
				// 1. We see shell patterns
				// 2. The output does NOT contain the agent command name (to avoid false positives during startup)
				// 3. We've waited at least 3 seconds (give agent command time to start)
				const outputLowercase = paneOutput.toLowerCase();
				const hasShellPatterns = SHELL_PROMPT_PATTERNS.some(p => paneOutput.includes(p));
				const mentionsAgent = outputLowercase.includes(selectedAgent.command.toLowerCase());
				const isLikelyShellPrompt = hasShellPatterns && !mentionsAgent && waited > 3000;

				if (hasAgentPatterns) {
					agentReady = true;
					console.log(`[spawn] ${selectedAgent.name} ready after ${waited}ms`);
				} else if (isLikelyShellPrompt && waited > 5000) {
					// If we see shell prompt after 5s, agent likely failed to start
					shellPromptDetected = true;
					console.error(`[spawn] ${selectedAgent.name} failed to start - detected shell prompt`);
					console.error(`[spawn] Terminal output (last 300 chars): ${stripAnsi(paneOutput.slice(-300))}`);
					break;
				}
			} catch {
				// Session might not exist yet, continue waiting
			}
		}

		// CRITICAL: Don't send /jat:start if agent isn't ready - it will go to bash!
		if (!agentReady) {
			if (shellPromptDetected) {
				// Shell prompt detected - agent definitely didn't start
				console.error(`[spawn] ABORTING: ${selectedAgent.name} did not start (shell prompt detected)`);
				return json({
					error: `${selectedAgent.name} failed to start`,
					message: `${selectedAgent.name} did not start within the timeout period. The session was created but the agent is not running. Try attaching to the terminal manually.`,
					sessionName,
					agentName,
					taskId,
					recoveryHint: `Try: tmux attach-session -t ${sessionName}`
				}, { status: 500 });
			}
			// No shell prompt but no agent patterns either - might still be starting
			console.warn(`[spawn] ${selectedAgent.name} may not have started properly after ${maxWaitSeconds}s, proceeding with caution`);
		}

		// Only send /jat:start for agents that use stdin injection (like Claude Code)
		// Agents with prompt injection (like OpenCode) already have their task via --prompt flag
		if (needsJatStart) {
			/**
			 * Send the initial prompt with retry logic
			 *
			 * CRITICAL: Claude Code's TUI doesn't reliably process Enter when sent
			 * in the same tmux send-keys command as the text. The fix is to:
			 * 1. Send text first (without Enter)
			 * 2. Brief delay for text to be fully typed
			 * 3. Send Enter separately
			 *
			 * This mimics how a human would type - text first, then press Enter.
			 */
			const escapedPrompt = initialPrompt.replace(/"/g, '\\"').replace(/\$/g, '\\$');
			const maxRetries = 3;
			let commandSent = false;

			for (let attempt = 1; attempt <= maxRetries && !commandSent; attempt++) {
				try {
					// Step 1: Send text WITHOUT Enter
					await execAsync(`tmux send-keys -t "${sessionName}" -- "${escapedPrompt}"`);

					// Step 2: Brief delay for text to be fully received by Claude's TUI
					await new Promise(resolve => setTimeout(resolve, 100));

					// Step 3: Send Enter SEPARATELY - this is the key fix!
					await execAsync(`tmux send-keys -t "${sessionName}" Enter`);

					// Wait for the command to be accepted by Claude Code
					// We need enough time for the slash command to start executing
					// but NOT so aggressive that we interrupt commands in progress
					await new Promise(resolve => setTimeout(resolve, 2000));

					// Check if the command was received
					// We look for signs the command is executing OR has been received
					// DO NOT use Ctrl-C retry - it interrupts in-flight bash commands
					// causing "Interrupted by user" errors (jat-t45zv)
					//
					// Use -S -40 -E -4 to capture agent output area only, skipping:
					// - Last 1-2 lines: statusline ("bypass permissions", JAT status)
					// - Last 2-3 lines: input prompt area
					const { stdout: paneOutput } = await execAsync(
						`tmux capture-pane -t "${sessionName}" -p -S -40 -E -4 2>/dev/null`
					);

					// Signs the command is executing or was received:
					// 1. "is running" - Claude Code shows this for slash commands
					// 2. "STARTING" - JAT signal state
					// 3. "Bash(" - Tool execution has started
					// 4. "● " - Tool execution indicator
					const commandReceived =
						paneOutput.includes('is running') ||
						paneOutput.includes('STARTING') ||
						paneOutput.includes('Bash(') ||
						paneOutput.includes('● ');

					if (commandReceived) {
						commandSent = true;
						console.log(`[spawn] Initial prompt sent successfully on attempt ${attempt}`);
					} else if (attempt < maxRetries) {
						// Check if command is still sitting in input buffer (separate capture for input area)
						// Use -S -3 -E -1 to capture just the input line area (skip only statusline)
						const { stdout: inputArea } = await execAsync(
							`tmux capture-pane -t "${sessionName}" -p -S -4 -E -1 2>/dev/null`
						);

						const inputStillVisible = inputArea.includes(initialPrompt) &&
							!inputArea.includes('is running');

						if (inputStillVisible) {
							// Command is still in input buffer - try sending Enter again
							console.log(`[spawn] Attempt ${attempt}: Command visible in input, sending Enter again...`);
							await execAsync(`tmux send-keys -t "${sessionName}" Enter`);
							await new Promise(resolve => setTimeout(resolve, 500));
						} else {
							// Command was likely received, just taking time to show "is running"
							// DO NOT send Ctrl-C - it will interrupt in-flight bash commands
							console.log(`[spawn] Attempt ${attempt}: Command likely in progress, waiting...`);
							await new Promise(resolve => setTimeout(resolve, 2000));
						}
					}
				} catch (err) {
					// Non-fatal - session is created, prompt just failed
					console.error(`[spawn] Attempt ${attempt} failed:`, err);
					if (attempt < maxRetries) {
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
				}
			}

			if (!commandSent) {
				console.warn(`[spawn] Initial prompt may not have been executed after ${maxRetries} attempts`);
			}
		} else {
			console.log(`[spawn] Skipping /jat:start - agent ${selectedAgent.name} uses prompt injection`);
		}

		// Step 4c: If imagePath provided, wait for agent to start working, then send the image
		// This gives the agent context (e.g., bug screenshot) after it has initialized
		if (imagePath) {
			// Wait for the agent to fully start and be ready for input
			await new Promise(resolve => setTimeout(resolve, 8000));

			try {
				// Send the image path as input - the agent can then view it with Read tool
				// Use same pattern as above: text first, then Enter separately
				const escapedPath = imagePath.replace(/"/g, '\\"').replace(/\$/g, '\\$');
				await execAsync(`tmux send-keys -t "${sessionName}" -- "${escapedPath}"`);
				await new Promise(resolve => setTimeout(resolve, 100));
				await execAsync(`tmux send-keys -t "${sessionName}" Enter`);
				console.log(`[spawn] Sent image path to session ${sessionName}: ${imagePath}`);
			} catch (err) {
				// Non-fatal - image send failed but session is still running
				console.error('Failed to send image path:', err);
			}
		}

		// Step 4b: If attach requested, open terminal window
		if (attach) {
			try {
				const { spawn } = await import('child_process');
				const isMacOS = process.platform === 'darwin';
				const displayName = projectName ? projectName.toUpperCase() : 'JAT';
				const windowTitle = `${displayName}: ${sessionName}`;
				const attachCmd = `tmux attach-session -t "${sessionName}"`;

				if (isMacOS) {
					// macOS: use osascript to open Terminal.app, iTerm2, or Ghostty
					const { existsSync } = await import('fs');
					if (existsSync('/Applications/Ghostty.app')) {
						const child = spawn('ghostty', ['+new-window', '-e', 'bash', '-c', attachCmd], {
							detached: true, stdio: 'ignore'
						});
						child.unref();
					} else if (existsSync('/Applications/iTerm.app')) {
						const child = spawn('osascript', ['-e', `
							tell application "iTerm"
								create window with default profile command "bash -c '${attachCmd}'"
								tell current session of current window
									set name to "${windowTitle}"
								end tell
							end tell
						`], { detached: true, stdio: 'ignore' });
						child.unref();
					} else {
						const child = spawn('osascript', ['-e', `
							tell application "Terminal"
								do script "bash -c '${attachCmd}'"
								set custom title of front window to "${windowTitle}"
								activate
							end tell
						`], { detached: true, stdio: 'ignore' });
						child.unref();
					}
				} else {
					// Linux: find available terminal emulator
					const { stdout: whichResult } = await execAsync('which ghostty alacritty kitty gnome-terminal konsole xterm 2>/dev/null | head -1 || true');
					const terminalPath = whichResult.trim();

					if (terminalPath) {
						let child;

						if (terminalPath.includes('ghostty')) {
							child = spawn('ghostty', ['--title=' + windowTitle, '-e', 'bash', '-c', `tmux attach-session -t "${sessionName}"`], {
								detached: true,
								stdio: 'ignore'
							});
						} else if (terminalPath.includes('alacritty')) {
							child = spawn('alacritty', ['--title', windowTitle, '-e', 'tmux', 'attach-session', '-t', sessionName], {
								detached: true,
								stdio: 'ignore'
							});
						} else if (terminalPath.includes('kitty')) {
							child = spawn('kitty', ['--title', windowTitle, 'tmux', 'attach-session', '-t', sessionName], {
								detached: true,
								stdio: 'ignore'
							});
						} else if (terminalPath.includes('gnome-terminal')) {
							child = spawn('gnome-terminal', ['--title', windowTitle, '--', 'tmux', 'attach-session', '-t', sessionName], {
								detached: true,
								stdio: 'ignore'
							});
						} else if (terminalPath.includes('konsole')) {
							child = spawn('konsole', ['--new-tab', '-e', 'tmux', 'attach-session', '-t', sessionName], {
								detached: true,
								stdio: 'ignore'
							});
						} else {
							child = spawn('xterm', ['-title', windowTitle, '-e', 'tmux', 'attach-session', '-t', sessionName], {
								detached: true,
								stdio: 'ignore'
							});
						}

						child.unref();
					}
				}
			} catch (err) {
				// Non-fatal - session is created, terminal just didn't open
				console.error('Failed to attach terminal:', err);
			}
		}

		// Step 4d: Apply Hyprland border colors for the project
		// This colors the terminal window based on project config
		// Do this after terminal is opened (attach mode) or immediately (non-attach mode)
		// Best-effort - don't fail spawn if coloring fails
		try {
			const colorProjectName = projectName || (taskId ? taskId.split('-')[0] : null);
			if (colorProjectName) {
				// Small delay to allow terminal window to be created
				setTimeout(async () => {
					try {
						const colorResponse = await globalThis.fetch(
							`http://localhost:${process.env.PORT || 3333}/api/sessions/${sessionName}/hyprland-color?project=${colorProjectName}`,
							{ method: 'POST' }
						);
						if (colorResponse.ok) {
							const colorResult = await colorResponse.json();
							console.log(`[spawn] Hyprland colors applied: ${colorResult.windowsUpdated || 0} windows`);
						}
					} catch (err) {
						// Silent - Hyprland coloring is optional
					}
				}, 1000);
			}
		} catch {
			// Silent - Hyprland coloring is optional
		}

		// Step 5: Build full task response from already-fetched task data
		// We already fetched task in Step 0 for routing evaluation
		let fullTask = null;
		if (task) {
			fullTask = {
				id: task.id,
				title: task.title,
				description: task.description,
				status: task.status,
				priority: task.priority,
				issue_type: task.issue_type
			};
		} else if (taskId) {
			// Minimal fallback if task wasn't fetched
			fullTask = { id: taskId };
		}

		// Step 6: Return WorkSession with agent selection info
		return json({
			success: true,
			session: {
				sessionName,
				agentName,
				agentProgram: selectedAgent.id,
				model: selectedModel.shortName,
				task: fullTask,
				project: projectName,  // Include project for session grouping on /work page
				imagePath: imagePath || null,
				output: '',
				lineCount: 0,
				tokens: 0,
				cost: 0,
				created: new Date().toISOString(),
				attached: attach,
				// Agent selection info
				matchedRule: matchedRule?.id || null,
				selectionReason
			},
			message: taskId
				? `Spawned ${selectedAgent.name} agent ${agentName} (${selectedModel.name}) for task ${taskId}${imagePath ? ' (with attached image)' : ''}`
				: `Spawned ${selectedAgent.name} planning session for agent ${agentName} (${selectedModel.name})`,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		console.error('Error in POST /api/work/spawn:', error);
		return json({
			error: 'Internal server error',
			message: error instanceof Error ? error.message : String(error)
		}, { status: 500 });
	}
}
