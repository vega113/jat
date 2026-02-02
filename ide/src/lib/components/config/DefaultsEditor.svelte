<script lang="ts">
	/**
	 * DefaultsEditor Component
	 *
	 * Form for editing JAT global defaults from ~/.config/jat/projects.json
	 * Settings here affect agent spawning, model selection, and timing.
	 */

	import { onMount } from 'svelte';
	import { updateAutoKillConfig } from '$lib/stores/autoKillConfig';

	// Types
	interface JatDefaults {
		terminal: string;
		editor: string;
		tools_path: string;
		claude_flags: string;
		model: string;
		agent_stagger: number;
		claude_startup_timeout: number;
		projects_session_height: number;
		projects_task_height: number;
		auto_kill_enabled: boolean;
		auto_kill_delay: number;
		auto_kill_p0: boolean;
		auto_kill_p1: boolean;
		auto_kill_p2: boolean;
		auto_kill_p3: boolean;
		auto_kill_p4: boolean;
		skip_permissions: boolean;
		file_watcher_ignored_dirs: string[];
	}

	// State
	let loading = $state(true);
	let saving = $state(false);
	let resetting = $state(false);
	let showResetConfirm = $state(false);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);
	let configPath = $state('');

	// Form values
	let terminal = $state('auto');
	let editor = $state('code');
	let toolsPath = $state('~/.local/bin');
	let claudeFlags = $state('--dangerously-skip-permissions');
	let model = $state('opus');
	let agentStagger = $state(15);
	let claudeStartupTimeout = $state(20);
	let projectsSessionHeight = $state(400);
	let projectsTaskHeight = $state(400);
	let autoKillEnabled = $state(false);
	let autoKillDelay = $state(30);
	let autoKillP0 = $state(false);
	let autoKillP1 = $state(false);
	let autoKillP2 = $state(false);
	let autoKillP3 = $state(true);
	let autoKillP4 = $state(true);
	let skipPermissions = $state(false);
	let fileWatcherIgnoredDirs = $state<string[]>([]);
	let newIgnoredDir = $state('');
	let launchingYolo = $state(false);
	let savingSkipPermissions = $state(false);

	// Track if form has changes
	let originalValues = $state<JatDefaults | null>(null);
	let hasChanges = $derived(
		originalValues !== null && (
			terminal !== originalValues.terminal ||
			editor !== originalValues.editor ||
			toolsPath !== originalValues.tools_path ||
			claudeFlags !== originalValues.claude_flags ||
			model !== originalValues.model ||
			agentStagger !== originalValues.agent_stagger ||
			claudeStartupTimeout !== originalValues.claude_startup_timeout ||
			projectsSessionHeight !== originalValues.projects_session_height ||
			projectsTaskHeight !== originalValues.projects_task_height ||
			autoKillEnabled !== originalValues.auto_kill_enabled ||
			autoKillDelay !== originalValues.auto_kill_delay ||
			autoKillP0 !== originalValues.auto_kill_p0 ||
			autoKillP1 !== originalValues.auto_kill_p1 ||
			autoKillP2 !== originalValues.auto_kill_p2 ||
			autoKillP3 !== originalValues.auto_kill_p3 ||
			autoKillP4 !== originalValues.auto_kill_p4 ||
			skipPermissions !== originalValues.skip_permissions ||
			JSON.stringify(fileWatcherIgnoredDirs) !== JSON.stringify(originalValues.file_watcher_ignored_dirs)
		)
	);

	// Validation rules
	const VALIDATION_RULES = {
		agentStagger: { min: 5, max: 300 },
		claudeStartupTimeout: { min: 10, max: 120 },
		projectsSessionHeight: { min: 100, max: 1200 },
		projectsTaskHeight: { min: 100, max: 1200 },
		autoKillDelay: { min: 5, max: 300 }
	};

	// Validation error messages (reactive)
	let agentStaggerError = $derived.by(() => {
		if (agentStagger < VALIDATION_RULES.agentStagger.min) {
			return `Minimum is ${VALIDATION_RULES.agentStagger.min} seconds`;
		}
		if (agentStagger > VALIDATION_RULES.agentStagger.max) {
			return `Maximum is ${VALIDATION_RULES.agentStagger.max} seconds`;
		}
		return null;
	});

	let claudeStartupTimeoutError = $derived.by(() => {
		if (claudeStartupTimeout < VALIDATION_RULES.claudeStartupTimeout.min) {
			return `Minimum is ${VALIDATION_RULES.claudeStartupTimeout.min} seconds`;
		}
		if (claudeStartupTimeout > VALIDATION_RULES.claudeStartupTimeout.max) {
			return `Maximum is ${VALIDATION_RULES.claudeStartupTimeout.max} seconds`;
		}
		return null;
	});

	let projectsSessionHeightError = $derived.by(() => {
		if (projectsSessionHeight < VALIDATION_RULES.projectsSessionHeight.min) {
			return `Minimum is ${VALIDATION_RULES.projectsSessionHeight.min}px`;
		}
		if (projectsSessionHeight > VALIDATION_RULES.projectsSessionHeight.max) {
			return `Maximum is ${VALIDATION_RULES.projectsSessionHeight.max}px`;
		}
		return null;
	});

	let projectsTaskHeightError = $derived.by(() => {
		if (projectsTaskHeight < VALIDATION_RULES.projectsTaskHeight.min) {
			return `Minimum is ${VALIDATION_RULES.projectsTaskHeight.min}px`;
		}
		if (projectsTaskHeight > VALIDATION_RULES.projectsTaskHeight.max) {
			return `Maximum is ${VALIDATION_RULES.projectsTaskHeight.max}px`;
		}
		return null;
	});

	let autoKillDelayError = $derived.by(() => {
		if (!autoKillEnabled) return null; // Only validate when enabled
		if (autoKillDelay < VALIDATION_RULES.autoKillDelay.min) {
			return `Minimum is ${VALIDATION_RULES.autoKillDelay.min} seconds`;
		}
		if (autoKillDelay > VALIDATION_RULES.autoKillDelay.max) {
			return `Maximum is ${VALIDATION_RULES.autoKillDelay.max} seconds`;
		}
		return null;
	});

	// Track if form has validation errors
	let hasValidationErrors = $derived(
		agentStaggerError !== null ||
		claudeStartupTimeoutError !== null ||
		projectsSessionHeightError !== null ||
		projectsTaskHeightError !== null ||
		autoKillDelayError !== null
	);

	// Load defaults on mount
	onMount(() => {
		loadDefaults();
	});

	async function loadDefaults() {
		loading = true;
		error = null;

		try {
			const response = await fetch('/api/config/defaults');
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to load defaults');
			}

			const defaults = data.defaults;
			terminal = defaults.terminal || 'auto';
			editor = defaults.editor || 'code';
			toolsPath = defaults.tools_path || '~/.local/bin';
			claudeFlags = defaults.claude_flags || '--dangerously-skip-permissions';
			model = defaults.model || 'opus';
			agentStagger = defaults.agent_stagger || 15;
			claudeStartupTimeout = defaults.claude_startup_timeout || 20;
			projectsSessionHeight = defaults.projects_session_height || 400;
			projectsTaskHeight = defaults.projects_task_height || 400;
			autoKillEnabled = defaults.auto_kill_enabled ?? true;
			autoKillDelay = defaults.auto_kill_delay ?? 30;
			autoKillP0 = defaults.auto_kill_p0 ?? true;
			autoKillP1 = defaults.auto_kill_p1 ?? true;
			autoKillP2 = defaults.auto_kill_p2 ?? true;
			autoKillP3 = defaults.auto_kill_p3 ?? true;
			autoKillP4 = defaults.auto_kill_p4 ?? true;
			skipPermissions = defaults.skip_permissions ?? false;
			fileWatcherIgnoredDirs = defaults.file_watcher_ignored_dirs ?? [];
			configPath = data.configPath || '';

			// Store original values for change detection
			originalValues = {
				...defaults,
				auto_kill_enabled: autoKillEnabled,
				auto_kill_delay: autoKillDelay,
				auto_kill_p0: autoKillP0,
				auto_kill_p1: autoKillP1,
				auto_kill_p2: autoKillP2,
				auto_kill_p3: autoKillP3,
				auto_kill_p4: autoKillP4,
				skip_permissions: skipPermissions,
				file_watcher_ignored_dirs: [...fileWatcherIgnoredDirs]
			};
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load defaults';
		} finally {
			loading = false;
		}
	}

	async function saveDefaults() {
		saving = true;
		error = null;
		success = null;

		try {
			const response = await fetch('/api/config/defaults', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					defaults: {
						terminal,
						editor,
						tools_path: toolsPath,
						claude_flags: claudeFlags,
						model,
						agent_stagger: agentStagger,
						claude_startup_timeout: claudeStartupTimeout,
						projects_session_height: projectsSessionHeight,
						projects_task_height: projectsTaskHeight,
						auto_kill_enabled: autoKillEnabled,
						auto_kill_delay: autoKillDelay,
						auto_kill_p0: autoKillP0,
						auto_kill_p1: autoKillP1,
						auto_kill_p2: autoKillP2,
						auto_kill_p3: autoKillP3,
						auto_kill_p4: autoKillP4,
						skip_permissions: skipPermissions,
						file_watcher_ignored_dirs: fileWatcherIgnoredDirs
					}
				})
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to save defaults');
			}

			// Update original values
			originalValues = {
				terminal,
				editor,
				tools_path: toolsPath,
				claude_flags: claudeFlags,
				model,
				agent_stagger: agentStagger,
				claude_startup_timeout: claudeStartupTimeout,
				projects_session_height: projectsSessionHeight,
				projects_task_height: projectsTaskHeight,
				auto_kill_enabled: autoKillEnabled,
				auto_kill_delay: autoKillDelay,
				auto_kill_p0: autoKillP0,
				auto_kill_p1: autoKillP1,
				auto_kill_p2: autoKillP2,
				auto_kill_p3: autoKillP3,
				auto_kill_p4: autoKillP4,
				skip_permissions: skipPermissions,
				file_watcher_ignored_dirs: [...fileWatcherIgnoredDirs]
			};

			// Update the runtime auto-kill config store so changes take effect immediately
			updateAutoKillConfig({
				enabled: autoKillEnabled,
				defaultDelaySeconds: autoKillDelay,
				priorityEnabled: {
					0: autoKillP0,
					1: autoKillP1,
					2: autoKillP2,
					3: autoKillP3,
					4: autoKillP4
				}
			});

			success = 'Defaults saved successfully';
			setTimeout(() => { success = null; }, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save defaults';
		} finally {
			saving = false;
		}
	}

	function resetToOriginal() {
		if (originalValues) {
			terminal = originalValues.terminal;
			editor = originalValues.editor;
			toolsPath = originalValues.tools_path;
			claudeFlags = originalValues.claude_flags;
			model = originalValues.model;
			agentStagger = originalValues.agent_stagger;
			claudeStartupTimeout = originalValues.claude_startup_timeout;
			projectsSessionHeight = originalValues.projects_session_height;
			projectsTaskHeight = originalValues.projects_task_height;
			autoKillEnabled = originalValues.auto_kill_enabled;
			autoKillDelay = originalValues.auto_kill_delay;
			autoKillP0 = originalValues.auto_kill_p0;
			autoKillP1 = originalValues.auto_kill_p1;
			autoKillP2 = originalValues.auto_kill_p2;
			autoKillP3 = originalValues.auto_kill_p3;
			autoKillP4 = originalValues.auto_kill_p4;
			skipPermissions = originalValues.skip_permissions;
			fileWatcherIgnoredDirs = [...originalValues.file_watcher_ignored_dirs];
		}
	}

	async function resetToFactory() {
		resetting = true;
		error = null;
		success = null;

		try {
			const response = await fetch('/api/config/defaults', {
				method: 'DELETE'
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to reset defaults');
			}

			// Update form with factory values
			const defaults = data.defaults;
			terminal = defaults.terminal;
			editor = defaults.editor;
			toolsPath = defaults.tools_path;
			claudeFlags = defaults.claude_flags;
			model = defaults.model;
			agentStagger = defaults.agent_stagger;
			claudeStartupTimeout = defaults.claude_startup_timeout;
			projectsSessionHeight = defaults.projects_session_height;
			projectsTaskHeight = defaults.projects_task_height;
			autoKillEnabled = defaults.auto_kill_enabled ?? true;
			autoKillDelay = defaults.auto_kill_delay ?? 30;
			autoKillP0 = defaults.auto_kill_p0 ?? true;
			autoKillP1 = defaults.auto_kill_p1 ?? true;
			autoKillP2 = defaults.auto_kill_p2 ?? true;
			autoKillP3 = defaults.auto_kill_p3 ?? true;
			autoKillP4 = defaults.auto_kill_p4 ?? true;
			skipPermissions = defaults.skip_permissions ?? false;
			fileWatcherIgnoredDirs = defaults.file_watcher_ignored_dirs ?? [];

			// Update original values
			originalValues = {
				...defaults,
				auto_kill_enabled: autoKillEnabled,
				auto_kill_delay: autoKillDelay,
				auto_kill_p0: autoKillP0,
				auto_kill_p1: autoKillP1,
				auto_kill_p2: autoKillP2,
				auto_kill_p3: autoKillP3,
				auto_kill_p4: autoKillP4,
				skip_permissions: skipPermissions,
				file_watcher_ignored_dirs: [...fileWatcherIgnoredDirs]
			};

			success = 'Defaults reset to factory values';
			setTimeout(() => { success = null; }, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to reset defaults';
		} finally {
			resetting = false;
			showResetConfirm = false;
		}
	}

	/**
	 * Launch a Claude session with --dangerously-skip-permissions flag
	 * so the user can accept the YOLO warning in their terminal
	 */
	async function launchYoloSession() {
		launchingYolo = true;
		error = null;

		try {
			const response = await fetch('/api/sessions/yolo', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to launch session');
			}

			success = 'Claude session launched! Accept the permissions warning in your terminal, then enable the toggle here.';
			setTimeout(() => { success = null; }, 8000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to launch session';
		} finally {
			launchingYolo = false;
		}
	}

	/**
	 * Add a new directory to the ignored list
	 */
	function addIgnoredDir() {
		const trimmed = newIgnoredDir.trim();
		if (trimmed && !fileWatcherIgnoredDirs.includes(trimmed)) {
			fileWatcherIgnoredDirs = [...fileWatcherIgnoredDirs, trimmed];
			newIgnoredDir = '';
		}
	}

	/**
	 * Remove a directory from the ignored list
	 */
	function removeIgnoredDir(dir: string) {
		fileWatcherIgnoredDirs = fileWatcherIgnoredDirs.filter(d => d !== dir);
	}

	/**
	 * Handle Enter key in the add directory input
	 */
	function handleIgnoredDirKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			addIgnoredDir();
		}
	}

	/**
	 * Auto-save skip_permissions when the toggle is changed
	 * This setting is important enough to save immediately without requiring Save button
	 */
	async function handleSkipPermissionsToggle(event: Event) {
		const checkbox = event.target as HTMLInputElement;
		const newValue = checkbox.checked;
		skipPermissions = newValue;
		savingSkipPermissions = true;
		error = null;

		try {
			const response = await fetch('/api/config/defaults', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					defaults: {
						skip_permissions: newValue
					}
				})
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to save setting');
			}

			// Update original value so hasChanges reflects saved state
			if (originalValues) {
				originalValues = { ...originalValues, skip_permissions: newValue };
			}

			success = newValue
				? 'Autonomous mode enabled. New agents will run without permission prompts.'
				: 'Autonomous mode disabled.';
			setTimeout(() => { success = null; }, 3000);
		} catch (err) {
			// Revert the toggle on error
			skipPermissions = !newValue;
			error = err instanceof Error ? err.message : 'Failed to save setting';
		} finally {
			savingSkipPermissions = false;
		}
	}
</script>

<div class="defaults-editor">
	<!-- Header -->
	<div class="editor-header">
		<div class="header-content">
			<h2 class="editor-title">Global Defaults</h2>
			<p class="editor-description">
				Configure global settings for agent spawning and system behavior.
				These values are stored in <code>{configPath || '~/.config/jat/projects.json'}</code>
			</p>
		</div>
	</div>

	{#if loading}
		<!-- Loading state -->
		<div class="loading-state">
			<div class="loading-spinner"></div>
			<p>Loading defaults...</p>
		</div>
	{:else if error && !originalValues}
		<!-- Error state (couldn't load) -->
		<div class="error-state">
			<svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="10"/>
				<path d="M12 8v4M12 16h.01"/>
			</svg>
			<p class="error-title">Failed to load defaults</p>
			<p class="error-message">{error}</p>
			<button class="retry-btn" onclick={loadDefaults}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
					<path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
				</svg>
				Retry
			</button>
		</div>
	{:else}
		<!-- Form -->
		<form class="defaults-form" onsubmit={(e) => { e.preventDefault(); if (!hasValidationErrors) saveDefaults(); }}>
			<!-- Status messages -->
			{#if error}
				<div class="alert alert-error">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="alert-icon">
						<circle cx="12" cy="12" r="10"/>
						<path d="M12 8v4M12 16h.01"/>
					</svg>
					<span>{error}</span>
				</div>
			{/if}

			{#if success}
				<div class="alert alert-success">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="alert-icon">
						<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
					</svg>
					<span>{success}</span>
				</div>
			{/if}

			<!-- Agent Spawning Section -->
			<div class="form-section">
				<h3 class="section-title">Agent Spawning</h3>

				<div class="form-group">
					<label class="form-label" for="model">
						Default Model
						<span class="label-hint">Claude model for new agents</span>
					</label>
					<select id="model" class="form-select" bind:value={model}>
						<option value="opus">Opus (Most capable)</option>
						<option value="sonnet">Sonnet (Balanced)</option>
						<option value="haiku">Haiku (Fastest)</option>
					</select>
				</div>

				<div class="form-group">
					<label class="form-label" for="claude-flags">
						Claude Flags
						<span class="label-hint">CLI flags passed to claude command</span>
					</label>
					<input
						type="text"
						id="claude-flags"
						class="form-input"
						bind:value={claudeFlags}
						placeholder="--dangerously-skip-permissions"
					/>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label class="form-label" for="agent-stagger">
							Agent Stagger
							<span class="label-hint">Seconds between batch spawns (min {VALIDATION_RULES.agentStagger.min})</span>
						</label>
						<div class="input-with-unit">
							<input
								type="number"
								id="agent-stagger"
								class="form-input"
								class:input-error={agentStaggerError}
								bind:value={agentStagger}
								min={VALIDATION_RULES.agentStagger.min}
								max={VALIDATION_RULES.agentStagger.max}
							/>
							<span class="input-unit">seconds</span>
						</div>
						{#if agentStaggerError}
							<span class="field-error">{agentStaggerError}</span>
						{/if}
					</div>

					<div class="form-group">
						<label class="form-label" for="startup-timeout">
							Startup Timeout
							<span class="label-hint">Wait time for Claude TUI (min {VALIDATION_RULES.claudeStartupTimeout.min})</span>
						</label>
						<div class="input-with-unit">
							<input
								type="number"
								id="startup-timeout"
								class="form-input"
								class:input-error={claudeStartupTimeoutError}
								bind:value={claudeStartupTimeout}
								min={VALIDATION_RULES.claudeStartupTimeout.min}
								max={VALIDATION_RULES.claudeStartupTimeout.max}
							/>
							<span class="input-unit">seconds</span>
						</div>
						{#if claudeStartupTimeoutError}
							<span class="field-error">{claudeStartupTimeoutError}</span>
						{/if}
					</div>
				</div>
			</div>

			<!-- Autonomous Mode Section -->
			<div class="form-section autonomous-section">
				<h3 class="section-title">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon">
						<path d="M13 10V3L4 14h7v7l9-11h-7z"/>
					</svg>
					Autonomous Mode
				</h3>
				<p class="section-description">
					Enable autonomous operation by passing <code>--dangerously-skip-permissions</code> to Claude
					and <code>--full-auto</code> to Codex. This allows agents to execute commands without confirmation prompts.
				</p>

				{#if !skipPermissions}
					<div class="autonomous-setup-section">
						<div class="autonomous-warning">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="warning-icon">
								<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
							</svg>
							<div class="warning-content">
								<strong>First time setup required</strong>
								<p>
									Before enabling this toggle, you must accept Claude's permissions warning once in your terminal.
									Click the button below to launch a Claude session where you can accept it.
								</p>
							</div>
						</div>

						<div class="autonomous-actions">
							<button
								type="button"
								class="btn btn-warning"
								onclick={launchYoloSession}
								disabled={launchingYolo}
							>
								{#if launchingYolo}
									<span class="btn-spinner"></span>
									Launching...
								{:else}
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
										<path d="M5 3l14 9-14 9V3z"/>
									</svg>
									Launch Claude to Accept Warning
								{/if}
							</button>
						</div>
					</div>
				{/if}

				<div class="form-group" style="margin-top: 1.25rem;">
					<label class="form-label toggle-label" for="skip-permissions">
						<span class="toggle-label-text">
							Enable autonomous mode
							<span class="label-hint">Pass --dangerously-skip-permissions to Claude and --full-auto to Codex</span>
							{#if savingSkipPermissions}
								<span class="saving-indicator">Saving...</span>
							{/if}
						</span>
						<input
							type="checkbox"
							id="skip-permissions"
							class="toggle toggle-warning"
							checked={skipPermissions}
							onchange={handleSkipPermissionsToggle}
							disabled={savingSkipPermissions}
						/>
					</label>
				</div>

				{#if skipPermissions}
					<div class="enabled-notice">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="notice-icon">
							<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
						</svg>
						<span>Autonomous mode is <strong>enabled</strong>. Agents will run without permission prompts.</span>
					</div>
				{/if}
			</div>

			<!-- Tools Section -->
			<div class="form-section">
				<h3 class="section-title">Tools & Environment</h3>

				<div class="form-group">
					<label class="form-label" for="terminal">
						Terminal
						<span class="label-hint">Terminal emulator for new sessions</span>
					</label>
					<input
						type="text"
						id="terminal"
						class="form-input"
						bind:value={terminal}
						placeholder="auto (detects platform default)"
					/>
				</div>

				<div class="form-group">
					<label class="form-label" for="editor">
						Editor
						<span class="label-hint">Code editor command</span>
					</label>
					<input
						type="text"
						id="editor"
						class="form-input"
						bind:value={editor}
						placeholder="code"
					/>
				</div>

				<div class="form-group">
					<label class="form-label" for="tools-path">
						Tools Path
						<span class="label-hint">Path to JAT tools directory</span>
					</label>
					<input
						type="text"
						id="tools-path"
						class="form-input"
						bind:value={toolsPath}
						placeholder="~/.local/bin"
					/>
				</div>
			</div>

			<!-- Layout Section -->
			<div class="form-section">
				<h3 class="section-title">Projects Page Layout</h3>

				<div class="form-row">
					<div class="form-group">
						<label class="form-label" for="session-height">
							Sessions Panel Height
							<span class="label-hint">Default height for sessions section</span>
						</label>
						<div class="input-with-unit">
							<input
								type="number"
								id="session-height"
								class="form-input"
								class:input-error={projectsSessionHeightError}
								bind:value={projectsSessionHeight}
								min={VALIDATION_RULES.projectsSessionHeight.min}
								max={VALIDATION_RULES.projectsSessionHeight.max}
							/>
							<span class="input-unit">px</span>
						</div>
						{#if projectsSessionHeightError}
							<span class="field-error">{projectsSessionHeightError}</span>
						{/if}
					</div>

					<div class="form-group">
						<label class="form-label" for="task-height">
							Tasks Panel Height
							<span class="label-hint">Default height for tasks section</span>
						</label>
						<div class="input-with-unit">
							<input
								type="number"
								id="task-height"
								class="form-input"
								class:input-error={projectsTaskHeightError}
								bind:value={projectsTaskHeight}
								min={VALIDATION_RULES.projectsTaskHeight.min}
								max={VALIDATION_RULES.projectsTaskHeight.max}
							/>
							<span class="input-unit">px</span>
						</div>
						{#if projectsTaskHeightError}
							<span class="field-error">{projectsTaskHeightError}</span>
						{/if}
					</div>
				</div>
			</div>

			<!-- Session Cleanup Section -->
			<div class="form-section">
				<h3 class="section-title">Session Cleanup</h3>
				<p class="section-description">
					Automatically close tmux sessions after tasks complete to prevent clutter.
				</p>

				<div class="form-group">
					<label class="form-label toggle-label" for="auto-kill-enabled">
						<span class="toggle-label-text">
							Auto-cleanup completed sessions
							<span class="label-hint">Kill tmux sessions after completion delay</span>
						</span>
						<input
							type="checkbox"
							id="auto-kill-enabled"
							class="toggle toggle-primary"
							bind:checked={autoKillEnabled}
						/>
					</label>
				</div>

				{#if autoKillEnabled}
					<div class="form-group" style="margin-top: 0.5rem;">
						<label class="form-label" for="auto-kill-delay">
							Cleanup Delay
							<span class="label-hint">Seconds to wait before killing session (allows review)</span>
						</label>
						<div class="input-with-unit">
							<input
								type="number"
								id="auto-kill-delay"
								class="form-input"
								class:input-error={autoKillDelayError}
								bind:value={autoKillDelay}
								min={VALIDATION_RULES.autoKillDelay.min}
								max={VALIDATION_RULES.autoKillDelay.max}
							/>
							<span class="input-unit">seconds</span>
						</div>
						{#if autoKillDelayError}
							<span class="field-error">{autoKillDelayError}</span>
						{/if}
						<p class="field-hint">
							Click on a session card during countdown to cancel auto-cleanup.
						</p>
					</div>

					<!-- Per-Priority Toggles -->
					<div class="form-group" style="margin-top: 1rem;">
						<label class="form-label">
							Priorities to Auto-Cleanup
							<span class="label-hint">Select which task priorities should auto-cleanup</span>
						</label>
						<div class="priority-toggles">
							<label class="priority-toggle" for="auto-kill-p0">
								<input
									type="checkbox"
									id="auto-kill-p0"
									class="checkbox checkbox-xs checkbox-error"
									bind:checked={autoKillP0}
								/>
								<span class="priority-badge priority-p0">P0</span>
								<span class="priority-label">Critical</span>
							</label>
							<label class="priority-toggle" for="auto-kill-p1">
								<input
									type="checkbox"
									id="auto-kill-p1"
									class="checkbox checkbox-xs checkbox-warning"
									bind:checked={autoKillP1}
								/>
								<span class="priority-badge priority-p1">P1</span>
								<span class="priority-label">High</span>
							</label>
							<label class="priority-toggle" for="auto-kill-p2">
								<input
									type="checkbox"
									id="auto-kill-p2"
									class="checkbox checkbox-xs checkbox-info"
									bind:checked={autoKillP2}
								/>
								<span class="priority-badge priority-p2">P2</span>
								<span class="priority-label">Medium</span>
							</label>
							<label class="priority-toggle" for="auto-kill-p3">
								<input
									type="checkbox"
									id="auto-kill-p3"
									class="checkbox checkbox-xs"
									bind:checked={autoKillP3}
								/>
								<span class="priority-badge priority-p3">P3</span>
								<span class="priority-label">Low</span>
							</label>
							<label class="priority-toggle" for="auto-kill-p4">
								<input
									type="checkbox"
									id="auto-kill-p4"
									class="checkbox checkbox-xs"
									bind:checked={autoKillP4}
								/>
								<span class="priority-badge priority-p4">P4</span>
								<span class="priority-label">Lowest</span>
							</label>
						</div>
						<p class="field-hint">
							Unchecked priorities will keep their sessions open after completion.
						</p>
					</div>
				{/if}
			</div>

			<!-- File Watcher Section -->
			<div class="form-section">
				<h3 class="section-title">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon">
						<path d="M3 3v18h18"/>
						<path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/>
					</svg>
					File Watcher
				</h3>
				<p class="section-description">
					Configure which directories are ignored when detecting file tree changes.
					Changes in these directories won't trigger the "changes detected" badge in the sidebar.
				</p>

				<!-- Current ignored directories -->
				<div class="form-group">
					<label class="form-label">
						Ignored Directories
						<span class="label-hint">Directories to exclude from change detection</span>
					</label>

					{#if fileWatcherIgnoredDirs.length > 0}
						<div class="ignored-dirs-list">
							{#each fileWatcherIgnoredDirs as dir}
								<div class="ignored-dir-item">
									<code class="dir-name">{dir}</code>
									<button
										type="button"
										class="remove-dir-btn"
										onclick={() => removeIgnoredDir(dir)}
										title="Remove {dir}"
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="remove-icon">
											<path d="M18 6L6 18M6 6l12 12"/>
										</svg>
									</button>
								</div>
							{/each}
						</div>
					{:else}
						<p class="empty-dirs-notice">No ignored directories configured.</p>
					{/if}
				</div>

				<!-- Add new directory -->
				<div class="form-group">
					<label class="form-label" for="new-ignored-dir">
						Add Directory
						<span class="label-hint">Enter a directory name to ignore (e.g., node_modules)</span>
					</label>
					<div class="add-dir-row">
						<input
							type="text"
							id="new-ignored-dir"
							class="form-input"
							bind:value={newIgnoredDir}
							onkeydown={handleIgnoredDirKeydown}
							placeholder=".cache"
						/>
						<button
							type="button"
							class="btn btn-secondary add-dir-btn"
							onclick={addIgnoredDir}
							disabled={!newIgnoredDir.trim()}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
								<path d="M12 5v14M5 12h14"/>
							</svg>
							Add
						</button>
					</div>
				</div>
			</div>

			<!-- Actions -->
			<div class="form-actions">
				<button
					type="button"
					class="btn btn-danger"
					onclick={() => showResetConfirm = true}
					disabled={saving || resetting}
				>
					Reset to Factory
				</button>
				<div class="actions-right">
					<button
						type="button"
						class="btn btn-secondary"
						onclick={resetToOriginal}
						disabled={!hasChanges || saving || resetting}
					>
						Undo Changes
					</button>
					<button
						type="submit"
						class="btn btn-primary"
						disabled={!hasChanges || saving || resetting || hasValidationErrors}
					>
						{#if saving}
							<span class="btn-spinner"></span>
							Saving...
						{:else}
							Save Changes
						{/if}
					</button>
				</div>
			</div>
		</form>
	{/if}
</div>

<!-- Reset Confirmation Modal -->
{#if showResetConfirm}
	<div class="modal-overlay" onclick={() => showResetConfirm = false}>
		<div class="modal-content" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<svg class="modal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
				</svg>
				<h3 class="modal-title">Reset to Factory Defaults?</h3>
			</div>
			<p class="modal-description">
				This will reset all settings to their original factory values. Your custom configuration will be removed from the config file.
			</p>
			<div class="modal-actions">
				<button
					type="button"
					class="btn btn-secondary"
					onclick={() => showResetConfirm = false}
					disabled={resetting}
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn btn-danger"
					onclick={resetToFactory}
					disabled={resetting}
				>
					{#if resetting}
						<span class="btn-spinner"></span>
						Resetting...
					{:else}
						Reset to Factory
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.defaults-editor {
		max-width: 700px;
	}

	/* Header */
	.editor-header {
		margin-bottom: 1.5rem;
	}

	.editor-title {
		font-size: 1.1rem;
		font-weight: 600;
		color: oklch(0.90 0.02 250);
		margin: 0 0 0.5rem 0;
		font-family: ui-monospace, monospace;
	}

	.editor-description {
		font-size: 0.85rem;
		color: oklch(0.60 0.02 250);
		margin: 0;
		line-height: 1.5;
	}

	.editor-description code {
		background: oklch(0.18 0.02 250);
		padding: 0.125rem 0.375rem;
		border-radius: 4px;
		font-size: 0.8rem;
		color: oklch(0.75 0.10 200);
	}

	/* Loading state */
	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 1rem;
		gap: 1rem;
		color: oklch(0.55 0.02 250);
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid oklch(0.30 0.02 250);
		border-top-color: oklch(0.65 0.15 200);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	/* Error state */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 1rem;
		gap: 0.5rem;
		color: oklch(0.55 0.02 250);
	}

	.error-icon {
		width: 48px;
		height: 48px;
		color: oklch(0.60 0.15 25);
		margin-bottom: 0.5rem;
	}

	.error-title {
		font-size: 0.9rem;
		font-weight: 500;
		color: oklch(0.70 0.12 25);
		margin: 0;
	}

	.error-message {
		font-size: 0.8rem;
		color: oklch(0.55 0.02 250);
		margin: 0;
	}

	.retry-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-top: 1rem;
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
		font-weight: 500;
		background: oklch(0.25 0.05 200);
		border: 1px solid oklch(0.35 0.08 200);
		border-radius: 6px;
		color: oklch(0.85 0.08 200);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.retry-btn:hover {
		background: oklch(0.30 0.08 200);
	}

	.btn-icon {
		width: 16px;
		height: 16px;
	}

	/* Form */
	.defaults-form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	/* Alert messages */
	.alert {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-radius: 8px;
		font-size: 0.85rem;
	}

	.alert-error {
		background: oklch(0.25 0.08 25);
		border: 1px solid oklch(0.40 0.12 25);
		color: oklch(0.85 0.10 25);
	}

	.alert-success {
		background: oklch(0.25 0.08 145);
		border: 1px solid oklch(0.40 0.12 145);
		color: oklch(0.85 0.10 145);
	}

	.alert-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
	}

	/* Form sections */
	.form-section {
		background: oklch(0.16 0.02 250);
		border: 1px solid oklch(0.25 0.02 250);
		border-radius: 10px;
		padding: 1.25rem;
	}

	.section-title {
		font-size: 0.9rem;
		font-weight: 600;
		color: oklch(0.80 0.08 200);
		margin: 0 0 1rem 0;
		font-family: ui-monospace, monospace;
	}

	/* Form groups */
	.form-group {
		margin-bottom: 1rem;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	@media (max-width: 500px) {
		.form-row {
			grid-template-columns: 1fr;
		}
	}

	.form-label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		font-weight: 500;
		color: oklch(0.80 0.02 250);
		margin-bottom: 0.5rem;
	}

	.label-hint {
		font-size: 0.75rem;
		font-weight: 400;
		color: oklch(0.55 0.02 250);
	}

	.form-input,
	.form-select {
		width: 100%;
		padding: 0.625rem 0.875rem;
		font-size: 0.875rem;
		font-family: ui-monospace, monospace;
		background: oklch(0.12 0.02 250);
		border: 1px solid oklch(0.28 0.02 250);
		border-radius: 6px;
		color: oklch(0.90 0.02 250);
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.form-input:focus,
	.form-select:focus {
		outline: none;
		border-color: oklch(0.55 0.15 200);
		box-shadow: 0 0 0 3px oklch(0.55 0.15 200 / 0.15);
	}

	.form-input::placeholder {
		color: oklch(0.45 0.02 250);
	}

	.form-select {
		cursor: pointer;
	}

	.input-with-unit {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.input-with-unit .form-input {
		width: 100px;
	}

	.input-unit {
		font-size: 0.8rem;
		color: oklch(0.55 0.02 250);
	}

	/* Error states */
	.input-error {
		border-color: oklch(0.55 0.18 25) !important;
	}

	.input-error:focus {
		border-color: oklch(0.55 0.18 25) !important;
		box-shadow: 0 0 0 3px oklch(0.55 0.18 25 / 0.15) !important;
	}

	.field-error {
		display: block;
		margin-top: 0.375rem;
		font-size: 0.75rem;
		color: oklch(0.70 0.15 25);
	}

	/* Actions */
	.form-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		padding-top: 0.5rem;
	}

	.actions-right {
		display: flex;
		gap: 0.75rem;
	}

	.btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.625rem 1.25rem;
		font-size: 0.85rem;
		font-weight: 500;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.15s ease;
		font-family: ui-monospace, monospace;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: oklch(0.55 0.15 200);
		border: 1px solid oklch(0.60 0.18 200);
		color: oklch(0.98 0.02 200);
	}

	.btn-primary:hover:not(:disabled) {
		background: oklch(0.60 0.18 200);
	}

	.btn-secondary {
		background: oklch(0.22 0.02 250);
		border: 1px solid oklch(0.32 0.02 250);
		color: oklch(0.75 0.02 250);
	}

	.btn-secondary:hover:not(:disabled) {
		background: oklch(0.28 0.02 250);
		color: oklch(0.85 0.02 250);
	}

	.btn-danger {
		background: oklch(0.35 0.12 25);
		border: 1px solid oklch(0.45 0.15 25);
		color: oklch(0.90 0.08 25);
	}

	.btn-danger:hover:not(:disabled) {
		background: oklch(0.40 0.15 25);
	}

	.btn-spinner {
		width: 14px;
		height: 14px;
		border: 2px solid oklch(0.98 0.02 200 / 0.3);
		border-top-color: oklch(0.98 0.02 200);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: oklch(0 0 0 / 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		backdrop-filter: blur(2px);
	}

	.modal-content {
		background: oklch(0.18 0.02 250);
		border: 1px solid oklch(0.30 0.02 250);
		border-radius: 12px;
		padding: 1.5rem;
		max-width: 420px;
		width: 90%;
		box-shadow: 0 20px 40px oklch(0 0 0 / 0.4);
	}

	.modal-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.modal-icon {
		width: 28px;
		height: 28px;
		color: oklch(0.70 0.18 45);
		flex-shrink: 0;
	}

	.modal-title {
		font-size: 1.1rem;
		font-weight: 600;
		color: oklch(0.90 0.02 250);
		margin: 0;
		font-family: ui-monospace, monospace;
	}

	.modal-description {
		font-size: 0.9rem;
		color: oklch(0.65 0.02 250);
		margin: 0 0 1.5rem 0;
		line-height: 1.5;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
	}

	/* Section description */
	.section-description {
		font-size: 0.8rem;
		color: oklch(0.55 0.02 250);
		margin: -0.5rem 0 1rem 0;
		line-height: 1.5;
	}

	/* Toggle label (horizontal layout) */
	.toggle-label {
		flex-direction: row !important;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.toggle-label-text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	/* Field hint (below inputs) */
	.field-hint {
		font-size: 0.75rem;
		color: oklch(0.50 0.02 250);
		margin-top: 0.5rem;
		line-height: 1.4;
	}

	/* Priority toggles grid */
	.priority-toggles {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	@media (min-width: 400px) {
		.priority-toggles {
			grid-template-columns: repeat(5, 1fr);
		}
	}

	.priority-toggle {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.625rem;
		background: oklch(0.14 0.02 250);
		border: 1px solid oklch(0.25 0.02 250);
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.priority-toggle:hover {
		background: oklch(0.18 0.02 250);
		border-color: oklch(0.30 0.02 250);
	}

	.priority-toggle:has(input:checked) {
		border-color: oklch(0.40 0.08 200);
		background: oklch(0.16 0.03 200);
	}

	.priority-badge {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.125rem 0.375rem;
		border-radius: 4px;
		font-family: ui-monospace, monospace;
	}

	.priority-p0 {
		background: oklch(0.40 0.15 25);
		color: oklch(0.95 0.05 25);
	}

	.priority-p1 {
		background: oklch(0.45 0.15 65);
		color: oklch(0.95 0.05 65);
	}

	.priority-p2 {
		background: oklch(0.40 0.12 230);
		color: oklch(0.95 0.05 230);
	}

	.priority-p3 {
		background: oklch(0.35 0.02 250);
		color: oklch(0.80 0.02 250);
	}

	.priority-p4 {
		background: oklch(0.30 0.02 250);
		color: oklch(0.70 0.02 250);
	}

	.priority-label {
		font-size: 0.75rem;
		color: oklch(0.65 0.02 250);
	}

	/* Autonomous Mode Section */
	.autonomous-section {
		border-color: oklch(0.35 0.12 45);
		background: oklch(0.16 0.03 45 / 0.3);
	}

	.section-icon {
		width: 18px;
		height: 18px;
		display: inline-block;
		vertical-align: middle;
		margin-right: 0.5rem;
		color: oklch(0.70 0.15 45);
	}

	.autonomous-warning {
		display: flex;
		gap: 0.75rem;
		padding: 1rem;
		background: oklch(0.20 0.08 45 / 0.4);
		border: 1px solid oklch(0.40 0.12 45 / 0.5);
		border-radius: 8px;
		margin-bottom: 1rem;
	}

	.warning-icon {
		width: 24px;
		height: 24px;
		flex-shrink: 0;
		color: oklch(0.70 0.18 45);
	}

	.warning-content {
		font-size: 0.85rem;
		color: oklch(0.75 0.02 250);
		line-height: 1.5;
	}

	.warning-content strong {
		color: oklch(0.85 0.10 45);
		display: block;
		margin-bottom: 0.25rem;
	}

	.warning-content p {
		margin: 0;
		color: oklch(0.65 0.02 250);
	}

	.autonomous-actions {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.btn-warning {
		background: oklch(0.45 0.12 45);
		border: 1px solid oklch(0.55 0.15 45);
		color: oklch(0.98 0.02 45);
	}

	.btn-warning:hover:not(:disabled) {
		background: oklch(0.50 0.15 45);
	}

	.already-enabled {
		font-size: 0.8rem;
		color: oklch(0.55 0.02 250);
		font-style: italic;
	}

	.autonomous-setup-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		overflow: hidden;
		animation: slideDown 0.3s ease-out;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			max-height: 0;
			transform: translateY(-10px);
		}
		to {
			opacity: 1;
			max-height: 300px;
			transform: translateY(0);
		}
	}

	.saving-indicator {
		display: inline-block;
		margin-left: 0.5rem;
		padding: 0.125rem 0.5rem;
		font-size: 0.7rem;
		color: oklch(0.85 0.15 200);
		background: oklch(0.30 0.08 200 / 0.5);
		border-radius: 0.25rem;
		animation: pulse 1s ease-in-out infinite;
	}

	.enabled-notice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		background: oklch(0.25 0.08 145 / 0.3);
		border: 1px solid oklch(0.40 0.12 145 / 0.5);
		border-radius: 8px;
		font-size: 0.85rem;
		color: oklch(0.80 0.10 145);
	}

	.notice-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: oklch(0.70 0.15 145);
	}

	/* File Watcher Section */
	.ignored-dirs-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.ignored-dir-item {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.5rem;
		background: oklch(0.18 0.02 250);
		border: 1px solid oklch(0.28 0.02 250);
		border-radius: 6px;
		transition: all 0.15s ease;
	}

	.ignored-dir-item:hover {
		background: oklch(0.20 0.02 250);
		border-color: oklch(0.35 0.02 250);
	}

	.dir-name {
		font-size: 0.8rem;
		font-family: ui-monospace, monospace;
		color: oklch(0.75 0.10 200);
		background: transparent;
		padding: 0;
	}

	.remove-dir-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		color: oklch(0.55 0.02 250);
		transition: all 0.15s ease;
	}

	.remove-dir-btn:hover {
		background: oklch(0.35 0.12 25);
		color: oklch(0.85 0.10 25);
	}

	.remove-icon {
		width: 12px;
		height: 12px;
	}

	.empty-dirs-notice {
		font-size: 0.8rem;
		color: oklch(0.50 0.02 250);
		font-style: italic;
		margin: 0.5rem 0 0 0;
	}

	.add-dir-row {
		display: flex;
		gap: 0.5rem;
		align-items: stretch;
	}

	.add-dir-row .form-input {
		flex: 1;
	}

	.add-dir-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.875rem;
		white-space: nowrap;
	}

	.add-dir-btn .btn-icon {
		width: 14px;
		height: 14px;
	}
</style>
