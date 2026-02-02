/**
 * Project Path Resolution
 *
 * Looks up project paths from JAT config and beads-discovered projects.
 * Used by task creation endpoints to find the correct directory.
 */
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const JAT_CONFIG_PATH = join(homedir(), '.config', 'jat', 'projects.json');

/**
 * @typedef {Object} JatProjectConfig
 * @property {string} [path] - Custom path to project
 * @property {string} [name] - Display name
 * @property {number} [port] - Dev server port
 */

/**
 * @typedef {Object} JatDefaults
 * @property {string} [terminal] - Default terminal emulator
 * @property {string} [editor] - Default code editor
 * @property {string} [tools_path] - Path to jat tools
 * @property {string} [claude_flags] - Claude command flags
 * @property {string} [model] - Default Claude model
 * @property {number} [agent_stagger] - Stagger delay between agent spawns (seconds)
 * @property {number} [claude_startup_timeout] - Claude startup timeout (seconds)
 * @property {number} [auto_proceed_delay] - Delay before spawning next task on auto-proceed (seconds)
 * @property {boolean} [skip_permissions] - Pass autonomous flags to agents (Claude: --dangerously-skip-permissions, Codex: --full-auto)
 */

/**
 * @typedef {Object} JatConfig
 * @property {Record<string, JatProjectConfig>} [projects] - Project configurations
 * @property {JatDefaults} [defaults] - Default settings
 */

/**
 * Read JAT config file
 * @returns {Promise<JatConfig|null>}
 */
async function readJatConfig() {
	try {
		if (!existsSync(JAT_CONFIG_PATH)) {
			return null;
		}
		const content = await readFile(JAT_CONFIG_PATH, 'utf-8');
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Scan ~/code for projects with .beads/ directories
 * @returns {Promise<Array<{name: string, path: string}>>}
 */
async function scanBeadsProjects() {
	const codeDir = join(homedir(), 'code');
	if (!existsSync(codeDir)) {
		return [];
	}

	try {
		const entries = await readdir(codeDir, { withFileTypes: true });
		const beadsProjects = [];

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) {
				continue;
			}

			const projectPath = join(codeDir, entry.name);
			const beadsDir = join(projectPath, '.beads');

			if (existsSync(beadsDir)) {
				beadsProjects.push({
					name: entry.name,
					path: projectPath
				});
			}
		}

		return beadsProjects;
	} catch {
		return [];
	}
}

/**
 * Get the filesystem path for a project by name
 *
 * Looks up in order:
 * 1. JAT config (supports custom paths)
 * 2. Beads-discovered projects (~/code/{name}/.beads/)
 * 3. Default fallback (~/code/{name})
 *
 * @param {string} projectName - Project name (e.g., "chimaro", "jat")
 * @returns {Promise<{path: string, source: 'jat-config' | 'beads-discovered' | 'default', exists: boolean}>}
 */
/**
 * Normalize a project name for comparison
 * Handles: case, underscores vs hyphens, spaces
 * @param {string} name
 * @returns {string}
 */
function normalizeProjectName(name) {
	return name.toLowerCase().replace(/[-_\s]/g, '');
}

export async function getProjectPath(projectName) {
	const normalizedName = normalizeProjectName(projectName);

	// 1. Check JAT config first (supports custom paths like /code/projects/foo)
	const jatConfig = await readJatConfig();
	if (jatConfig?.projects) {
		for (const [key, config] of Object.entries(jatConfig.projects)) {
			if (normalizeProjectName(key) === normalizedName) {
				const path = config.path?.replace(/^~/, homedir()) || join(homedir(), 'code', key);
				return {
					path,
					source: 'jat-config',
					exists: existsSync(path)
				};
			}
		}
	}

	// 2. Default fallback (auto-discovery disabled - config is source of truth)
	const defaultPath = join(homedir(), 'code', projectName);
	return {
		path: defaultPath,
		source: 'default',
		exists: existsSync(defaultPath)
	};
}

/**
 * Get JAT config defaults
 *
 * Returns defaults from ~/.config/jat/projects.json with fallback values.
 * Used for configurable settings like Claude startup timeout.
 *
 * @returns {Promise<JatDefaults>}
 */
export async function getJatDefaults() {
	const jatConfig = await readJatConfig();

	// Default values
	// NOTE: skip_permissions defaults to false for safety - user must explicitly enable
	// after they've manually accepted the YOLO warning once
	const defaults = {
		terminal: 'auto',
		editor: 'code',
		tools_path: '~/.local/bin',
		claude_flags: '',
		model: 'opus',
		agent_stagger: 15,
		claude_startup_timeout: 20,
		auto_proceed_delay: 2,
		skip_permissions: false
	};

	// Override with config values if present
	if (jatConfig?.defaults) {
		const configDefaults = jatConfig.defaults;
		if (configDefaults.terminal) defaults.terminal = configDefaults.terminal;
		if (configDefaults.editor) defaults.editor = configDefaults.editor;
		if (configDefaults.tools_path) defaults.tools_path = configDefaults.tools_path;
		if (configDefaults.claude_flags) defaults.claude_flags = configDefaults.claude_flags;
		if (configDefaults.model) defaults.model = configDefaults.model;
		if (typeof configDefaults.agent_stagger === 'number') defaults.agent_stagger = configDefaults.agent_stagger;
		if (typeof configDefaults.claude_startup_timeout === 'number') defaults.claude_startup_timeout = configDefaults.claude_startup_timeout;
		if (typeof configDefaults.auto_proceed_delay === 'number') defaults.auto_proceed_delay = configDefaults.auto_proceed_delay;
		if (typeof configDefaults.skip_permissions === 'boolean') defaults.skip_permissions = configDefaults.skip_permissions;
	}

	return defaults;
}
