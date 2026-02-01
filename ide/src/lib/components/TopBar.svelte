<script lang="ts">
	/**
	 * TopBar Component - Horizontal utilities bar
	 *
	 * Simplified navigation bar containing only utility components:
	 * - Hamburger toggle (mobile only, for sidebar)
	 * - AgentCountBadge
	 * - TokenUsageBadge (tokens today, cost, sparkline)
	 * - CommandPalette
	 * - UserProfile
	 *
	 * Navigation buttons (List, Graph, Agents) removed - moved to Sidebar
	 * Project filtering removed - handled by TaskTable filter bar
	 *
	 * Props:
	 * - tokensToday: number (total tokens consumed today)
	 * - costToday: number (total cost today in USD)
	 * - sparklineData: DataPoint[] (24h sparkline data)
	 */

	import { page } from "$app/stores";
	import ActivityBadge from "./ActivityBadge.svelte";
	import ActionPill from "./ActionPill.svelte";
	import ServersBadge from "./ServersBadge.svelte";
	import UserProfile from "./UserProfile.svelte";
	import CommandPalette from "./CommandPalette.svelte";
	import {
		openTaskDrawer,
		toggleSidebar,
		isSidebarCollapsed,
	} from "$lib/stores/drawerStore";
	import {
		startSpawning,
		stopSpawning,
		startBulkSpawn,
		endBulkSpawn,
	} from "$lib/stores/spawningTasks";
	import {
		AGENT_SORT_OPTIONS,
		initAgentSort,
		handleAgentSortClick,
		getAgentSortBy,
		getAgentSortDir,
		type AgentSortOption,
	} from "$lib/stores/agentSort.svelte.js";
	import {
		SERVER_SORT_OPTIONS,
		initServerSort,
		handleServerSortClick,
		getServerSortBy,
		getServerSortDir,
		type ServerSortOption,
	} from "$lib/stores/serverSort.svelte.js";
	import { onMount } from "svelte";
	import { SPAWN_STAGGER_MS } from "$lib/config/spawnConfig";
	import { getMaxSessions } from "$lib/stores/preferences.svelte";

	// Initialize sort stores on mount
	onMount(() => {
		initAgentSort();
		initServerSort();
	});

	// Check which page we're on for showing appropriate sort dropdown
	const isAgentsPage = $derived($page.url.pathname === "/agents");
	const isServersPage = $derived($page.url.pathname === "/servers");

	// Sort dropdown state (shared between agent and server pages)
	let showSortDropdown = $state(false);
	let sortHovered = $state(false);
	let sortDropdownTimeout: ReturnType<typeof setTimeout> | null = null;

	// Get current sort state reactively (agents page)
	const currentAgentSort = $derived(getAgentSortBy());
	const currentAgentDir = $derived(getAgentSortDir());
	const currentAgentSortLabel = $derived(
		AGENT_SORT_OPTIONS.find((o) => o.value === currentAgentSort)?.label ??
			"Sort",
	);
	const currentAgentSortIcon = $derived(
		AGENT_SORT_OPTIONS.find((o) => o.value === currentAgentSort)?.icon ?? "🔔",
	);

	// Get current sort state reactively (servers page)
	const currentServerSort = $derived(getServerSortBy());
	const currentServerDir = $derived(getServerSortDir());
	const currentServerSortLabel = $derived(
		SERVER_SORT_OPTIONS.find((o) => o.value === currentServerSort)?.label ??
			"Sort",
	);
	const currentServerSortIcon = $derived(
		SERVER_SORT_OPTIONS.find((o) => o.value === currentServerSort)?.icon ??
			"🔔",
	);

	// Handle sort dropdown show/hide with delay
	function showSortMenu() {
		if (sortDropdownTimeout) clearTimeout(sortDropdownTimeout);
		showSortDropdown = true;
	}

	function hideSortMenuDelayed() {
		sortDropdownTimeout = setTimeout(() => {
			showSortDropdown = false;
		}, 150);
	}

	function keepSortMenuOpen() {
		if (sortDropdownTimeout) clearTimeout(sortDropdownTimeout);
	}

	function onAgentSortSelect(value: AgentSortOption) {
		handleAgentSortClick(value);
		showSortDropdown = false;
	}

	function onServerSortSelect(value: ServerSortOption) {
		handleServerSortClick(value);
		showSortDropdown = false;
	}

	// Global action loading states
	let newSessionLoading = $state(false);
	let swarmLoading = $state(false);

	// New Session - spawn a planning session in selected project
	async function handleNewSession(projectName: string) {
		newSessionLoading = true;
		showSessionDropdown = false;
		try {
			const response = await fetch("/api/work/spawn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					attach: true,
					project: projectName,
				}),
			});
			const data = await response.json();
			if (!response.ok) {
				throw new Error(data.message || "Failed to spawn session");
			}
		} catch (error) {
			alert(error instanceof Error ? error.message : "Failed to spawn session");
		} finally {
			newSessionLoading = false;
		}
	}

	// Swarm - spawn one agent per ready task up to MAX_SESSIONS limit
	async function handleSwarm() {
		swarmLoading = true;
		startBulkSpawn(); // Signal bulk spawn started for TaskTable animations
		try {
			// Step 1: Get current active sessions to calculate available slots
			const workResponse = await fetch("/api/work");
			const workData = await workResponse.json();
			const activeSessionCount = workData.count || 0;
			const currentMaxSessions = getMaxSessions(); // Get current preference value
			const availableSlots = Math.max(
				0,
				currentMaxSessions - activeSessionCount,
			);

			if (availableSlots === 0) {
				throw new Error(
					`All ${currentMaxSessions} session slots are in use. Close some sessions first.`,
				);
			}

			// Step 2: Get ready tasks
			const readyResponse = await fetch("/api/tasks/ready");
			const readyData = await readyResponse.json();

			if (!readyResponse.ok || !readyData.tasks?.length) {
				throw new Error("No ready tasks available");
			}

			// Limit tasks to available slots
			const tasksToSpawn = readyData.tasks.slice(0, availableSlots);
			const skippedCount = readyData.tasks.length - tasksToSpawn.length;
			const results = [];

			// Step 3: Spawn an agent for each ready task (up to limit)
			for (let i = 0; i < tasksToSpawn.length; i++) {
				const task = tasksToSpawn[i];
				startSpawning(task.id); // Signal this task is spawning for animation
				try {
					const response = await fetch("/api/work/spawn", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ taskId: task.id }),
					});
					const data = await response.json();

					if (!response.ok) {
						results.push({
							taskId: task.id,
							success: false,
							error: data.message || "Failed to spawn",
						});
						stopSpawning(task.id); // Clear animation on failure
					} else {
						results.push({
							taskId: task.id,
							success: true,
							agentName: data.session?.agentName,
						});
						// Keep spawning animation until TaskTable refreshes and sees the new status
						setTimeout(() => stopSpawning(task.id), 2000);
					}
				} catch (err) {
					results.push({
						taskId: task.id,
						success: false,
						error: err instanceof Error ? err.message : "Unknown error",
					});
					stopSpawning(task.id); // Clear animation on error
				}

				// Stagger between spawns (except last one)
				if (i < tasksToSpawn.length - 1) {
					await new Promise((resolve) => setTimeout(resolve, SPAWN_STAGGER_MS));
				}
			}

			const successCount = results.filter((r) => r.success).length;

			if (successCount === 0) {
				throw new Error("Failed to spawn any agents");
			}

		} catch (error) {
			alert(error instanceof Error ? error.message : "Failed to spawn agents");
		} finally {
			swarmLoading = false;
			endBulkSpawn(); // Signal bulk spawn ended
		}
	}

	interface DataPoint {
		timestamp: string;
		tokens: number;
		cost: number;
	}

	/** Per-project token data from multi-project API */
	interface ProjectTokenData {
		project: string;
		tokens: number;
		cost: number;
		color: string;
	}

	/** Multi-project time-series data point from API */
	interface MultiProjectDataPoint {
		timestamp: string;
		totalTokens: number;
		totalCost: number;
		projects: ProjectTokenData[];
	}

	/** Ready task structure from /api/tasks/ready */
	interface ReadyTask {
		id: string;
		title: string;
		priority: number;
		type: string;
		project: string;
	}

	/** Epic with ready children for Run Epic feature */
	interface EpicWithReady {
		id: string;
		title: string;
		project: string;
		readyCount: number;
		totalCount: number;
	}

	/** Review rule structure */
	interface ReviewRule {
		type: string;
		maxAutoPriority: number;
		note?: string;
	}

	interface StateCounts {
		needsInput: number;
		working: number;
		review: number;
		completed: number;
		starting?: number;
		idle?: number;
	}

	interface Props {
		activeAgentCount?: number;
		totalAgentCount?: number;
		activeAgents?: string[];
		stateCounts?: StateCounts;
		tokensToday?: number;
		costToday?: number;
		sparklineData?: DataPoint[];
		/** Multi-project sparkline data (from ?multiProject=true API) */
		multiProjectData?: MultiProjectDataPoint[];
		/** Project colors map (from API response) */
		projectColors?: Record<string, string>;
		/** Number of ready tasks for Swarm button */
		readyTaskCount?: number;
		/** Ready tasks list for swarm dropdown */
		readyTasks?: ReadyTask[];
		/** Available projects for session spawning */
		projects?: string[];
		/** Currently selected project filter (for auto-detection) */
		selectedProject?: string;
		/** Open epics with ready children */
		epicsWithReady?: EpicWithReady[];
		/** Current review rules */
		reviewRules?: ReviewRule[];
		/** Callback to open global file search (Ctrl+Shift+F) */
		onGlobalSearchOpen?: () => void;
	}

	let {
		activeAgentCount = 0,
		totalAgentCount = 0,
		activeAgents = [],
		stateCounts,
		tokensToday = 0,
		costToday = 0,
		sparklineData = [],
		multiProjectData,
		projectColors = {},
		readyTaskCount = 0,
		readyTasks = [],
		projects = [],
		selectedProject = "All Projects",
		epicsWithReady = [],
		reviewRules = [],
		onGlobalSearchOpen,
	}: Props = $props();


	// Get actual project list (filter out "All Projects")
	const actualProjects = $derived(projects.filter((p) => p !== "All Projects"));


	// Max sessions from user preferences (reactive)
	const maxSessions = $derived(getMaxSessions());

	// Calculate available slots and effective spawn count for Run All Ready
	const availableSlots = $derived(Math.max(0, maxSessions - activeAgentCount));
	const effectiveSpawnCount = $derived(
		Math.min(readyTaskCount, availableSlots),
	);

	// Handle task creation for selected project
	function handleNewTask(projectName: string) {
		openTaskDrawer(projectName);
	}

	// Run Epic - spawn agents for all ready children of an epic
	let runningEpicId = $state<string | null>(null);

	async function handleRunEpic(epicId: string) {
		if (runningEpicId || swarmLoading) return;

		runningEpicId = epicId;

		try {
			// Fetch epic's children with ready status
			const response = await fetch(`/api/epics/${epicId}/children`);
			if (!response.ok) {
				throw new Error("Failed to fetch epic children");
			}
			const data = await response.json();

			// Filter to ready children only
			const readyChildren = data.children.filter(
				(c: { isBlocked: boolean; status: string }) =>
					!c.isBlocked && c.status !== "closed" && c.status !== "in_progress",
			);

			if (readyChildren.length === 0) {
				return;
			}

			startBulkSpawn();

			// Spawn agents for each ready child
			const staggerMs = 6000;
			for (let i = 0; i < readyChildren.length; i++) {
				const task = readyChildren[i];
				startSpawning(task.id);

				try {
					const spawnResponse = await fetch("/api/work/spawn", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ taskId: task.id }),
					});

					if (!spawnResponse.ok) {
						stopSpawning(task.id);
					} else {
						setTimeout(() => stopSpawning(task.id), 2000);
					}
				} catch (err) {
					stopSpawning(task.id);
				}

				// Stagger between spawns
				if (i < readyChildren.length - 1) {
					await new Promise((resolve) => setTimeout(resolve, staggerMs));
				}
			}

		} catch (err) {
		} finally {
			runningEpicId = null;
			endBulkSpawn();
		}
	}

	// Get epics with ready children count (used by ActionPill)
	const epicsWithReadyChildren = $derived(
		epicsWithReady
			.filter((e) => e.readyCount > 0)
			.sort((a, b) => b.readyCount - a.readyCount),
	);

	// Spawn a single task (called by ActionPill)
	let spawningTaskId = $state<string | null>(null);

	async function handleSpawnSingle(taskId: string) {
		if (spawningTaskId || swarmLoading) return;

		spawningTaskId = taskId;
		startSpawning(taskId);

		try {
			const response = await fetch("/api/work/spawn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ taskId }),
			});

			if (!response.ok) {
				stopSpawning(taskId);
			} else {
				// Keep animation briefly then clear
				setTimeout(() => stopSpawning(taskId), 2000);
			}
		} catch (err) {
			stopSpawning(taskId);
		} finally {
			spawningTaskId = null;
		}
	}

	// Group ready tasks by project for ActionPill
	const tasksByProject = $derived.by(() => {
		const groups = new Map<string, ReadyTask[]>();
		for (const task of readyTasks) {
			const project = task.project || "unknown";
			if (!groups.has(project)) {
				groups.set(project, []);
			}
			groups.get(project)!.push(task);
		}
		// Sort by priority within each group
		for (const tasks of groups.values()) {
			tasks.sort((a, b) => a.priority - b.priority);
		}
		return groups;
	});
</script>

<!-- Industrial/Terminal TopBar -->
<nav
	class="w-full h-12 flex items-center relative"
	style="
		background: linear-gradient(180deg, var(--color-base-200) 0%, var(--color-base-300) 100%);
		border-bottom: 1px solid var(--color-base-content);
		border-bottom-opacity: 0.2;
	"
>
	<!-- Mobile hamburger menu (visible on small screens) -->
	<label
		for="main-drawer"
		aria-label="open menu"
		class="lg:hidden flex items-center justify-center w-7 h-7 ml-3 rounded cursor-pointer transition-all hover:scale-105 bg-base-200 border border-base-content/20 text-primary"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
			stroke-width="2"
			stroke="currentColor"
			class="w-4 h-4"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
		</svg>
	</label>

	<!-- Sidebar toggle (industrial - visible on large screens) -->
	<button
		onclick={toggleSidebar}
		aria-label={$isSidebarCollapsed ? "expand sidebar" : "collapse sidebar"}
		class="hidden lg:flex items-center justify-center w-7 h-7 ml-3 rounded cursor-pointer transition-all hover:scale-105 bg-base-200 border border-base-content/20 text-primary"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			stroke-linejoin="round"
			stroke-linecap="round"
			stroke-width="2"
			fill="none"
			stroke="currentColor"
			class="w-4 h-4 transition-transform {$isSidebarCollapsed ? 'rotate-180' : ''}"
		>
			<path
				d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"
			></path>
			<path d="M9 4v16"></path>
			<path d="M14 10l2 2l-2 2"></path>
		</svg>
	</button>

	<!-- Left side utilities -->
	<div class="flex-1 flex items-center gap-3 px-4">
		<!-- Unified Action Pill: + New | ▶ Start | ⚡ Swarm -->
		<ActionPill
			projects={actualProjects.map(p => ({ name: p, taskCount: tasksByProject.get(p)?.length }))}
			{readyTasks}
			epics={epicsWithReadyChildren.map(e => ({ id: e.id, title: e.title, project: e.project, childCount: e.readyCount }))}
			idleSlots={availableSlots}
			onNewTask={handleNewTask}
			onStart={handleSpawnSingle}
			onSwarm={(count, epicId) => epicId ? handleRunEpic(epicId) : handleSwarm()}
		/>
	</div>

	<!-- Agent Sort Dropdown (on /agents page) -->
	{#if isAgentsPage}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="relative flex-none"
			onmouseenter={showSortMenu}
			onmouseleave={hideSortMenuDelayed}
		>
			<button
				class="flex items-center gap-1 py-1 mr-3 rounded font-mono text-[10px] tracking-wider uppercase transition-all duration-200 ease-out overflow-hidden btn btn-sm btn-ghost"
				class:btn-active={sortHovered || showSortDropdown}
				style="
					padding-left: 8px;
					padding-right: 8px;
				"
				title="Sort agents"
				onmouseenter={() => (sortHovered = true)}
				onmouseleave={() => (sortHovered = false)}
			>
				<span class="text-xs">{currentAgentSortIcon}</span>
				<span class="hidden sm:inline">{currentAgentSortLabel}</span>
				<span class="text-[9px] opacity-70"
					>{currentAgentDir === "asc" ? "▲" : "▼"}</span
				>
				<svg
					class="w-2.5 h-2.5 ml-0.5 transition-transform {showSortDropdown
						? 'rotate-180'
						: ''}"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M19.5 8.25l-7.5 7.5-7.5-7.5"
					/>
				</svg>
			</button>

			<!-- Agent Sort Dropdown Menu -->
			{#if showSortDropdown}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="absolute top-full left-0 mt-1 min-w-[160px] rounded-lg shadow-xl z-50 overflow-hidden dropdown-content bg-base-200 border border-base-content/20"
					onmouseenter={keepSortMenuOpen}
					onmouseleave={hideSortMenuDelayed}
				>
					<div
						class="px-3 py-2 border-b border-base-content/10"
					>
						<span
							class="text-[9px] font-mono uppercase tracking-wider text-base-content/60"
						>
							Sort Agents
						</span>
					</div>
					<div class="py-1">
						{#each AGENT_SORT_OPTIONS as opt (opt.value)}
							<button
								class="w-full px-3 py-2 text-left text-xs font-mono flex items-center gap-2 transition-colors hover:bg-base-300"
								class:text-primary={currentAgentSort === opt.value}
								class:bg-base-300={currentAgentSort === opt.value}
								onclick={() => onAgentSortSelect(opt.value)}
							>
								<span class="text-sm">{opt.icon}</span>
								<span class="flex-1">{opt.label}</span>
								{#if currentAgentSort === opt.value}
									<span class="text-[10px] opacity-70"
										>{currentAgentDir === "asc" ? "▲" : "▼"}</span
									>
								{/if}
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Server Sort Dropdown (on /servers page) -->
	{#if isServersPage}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="relative flex-none"
			onmouseenter={showSortMenu}
			onmouseleave={hideSortMenuDelayed}
		>
			<button
				class="flex items-center gap-1 py-1 mr-3 rounded font-mono text-[10px] tracking-wider uppercase transition-all duration-200 ease-out overflow-hidden btn btn-sm btn-ghost"
				class:btn-active={sortHovered || showSortDropdown}
				style="
					padding-left: 8px;
					padding-right: 8px;
				"
				title="Sort servers"
				onmouseenter={() => (sortHovered = true)}
				onmouseleave={() => (sortHovered = false)}
			>
				<span class="text-xs">{currentServerSortIcon}</span>
				<span class="hidden sm:inline">{currentServerSortLabel}</span>
				<span class="text-[9px] opacity-70"
					>{currentServerDir === "asc" ? "▲" : "▼"}</span
				>
				<svg
					class="w-2.5 h-2.5 ml-0.5 transition-transform {showSortDropdown
						? 'rotate-180'
						: ''}"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M19.5 8.25l-7.5 7.5-7.5-7.5"
					/>
				</svg>
			</button>

			<!-- Server Sort Dropdown Menu -->
			{#if showSortDropdown}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="absolute top-full left-0 mt-1 min-w-[160px] rounded-lg shadow-xl z-50 overflow-hidden dropdown-content bg-base-200 border border-base-content/20"
					onmouseenter={keepSortMenuOpen}
					onmouseleave={hideSortMenuDelayed}
				>
					<div
						class="px-3 py-2 border-b border-base-content/10"
					>
						<span
							class="text-[9px] font-mono uppercase tracking-wider text-base-content/60"
						>
							Sort Servers
						</span>
					</div>
					<div class="py-1">
						{#each SERVER_SORT_OPTIONS as opt (opt.value)}
							<button
								class="w-full px-3 py-2 text-left text-xs font-mono flex items-center gap-2 transition-colors hover:bg-base-300"
								class:text-primary={currentServerSort === opt.value}
								class:bg-base-300={currentServerSort === opt.value}
								onclick={() => onServerSortSelect(opt.value)}
							>
								<span class="text-sm">{opt.icon}</span>
								<span class="flex-1">{opt.label}</span>
								{#if currentServerSort === opt.value}
									<span class="text-[10px] opacity-70"
										>{currentServerDir === "asc" ? "▲" : "▼"}</span
									>
								{/if}
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Middle: Command Palette + Global Search -->
	<div class="flex-none flex items-center gap-2">
		<CommandPalette />

		<!-- Global File Search Button -->
		{#if onGlobalSearchOpen}
			<button
				class="px-2 py-1 rounded text-xs font-mono flex items-center gap-1.5 transition-all hover:scale-105"
				style="
					background: oklch(0.18 0.01 250);
					border: 1px solid oklch(0.35 0.02 250);
					color: oklch(0.60 0.02 250);
				"
				onclick={onGlobalSearchOpen}
				aria-label="Global file search (Ctrl+Shift+F)"
			>
				<!-- Search/Magnifying glass icon -->
				<svg
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
					stroke-width="1.5"
					stroke="currentColor"
					class="w-3 h-3"
					style="color: oklch(0.55 0.02 250);"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
					/>
				</svg>
				<span class="hidden lg:inline pt-0.5">Ctrl+Shift+F</span>
			</button>
		{/if}
	</div>

	<!-- Vertical separator -->
	<div
		class="w-px h-6 mx-3 bg-gradient-to-b from-transparent via-base-content/45 to-transparent"
	></div>

	<!-- Right side: Activity Badge + Servers + User Profile -->
	<div class="flex-none flex items-center gap-2.5 pr-3">
		<!-- Combined Activity Badge (Agents + Tasks + Tokens in dropdown) -->
		<ActivityBadge
			{activeAgentCount}
			{stateCounts}
			{tokensToday}
			{costToday}
			{sparklineData}
			{multiProjectData}
			{projectColors}
		/>

		<!-- Dev Servers + WebSocket Status -->
		<ServersBadge />

		<!-- User Profile -->
		<UserProfile />
	</div>
</nav>

<style>
	/* Swarm Dropdown Panel */
	.swarm-dropdown-panel {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 0.25rem;
		z-index: 50;
		min-width: 320px;
		max-width: 400px;
		border-radius: 0.5rem;
		box-shadow: 0 10px 40px oklch(0 0 0 / 0.4);
		overflow: hidden;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-content);
		border-opacity: 0.2;
		animation: swarm-dropdown-slide 0.2s ease-out;
		transform-origin: top left;
	}

	@keyframes swarm-dropdown-slide {
		from {
			opacity: 0;
			transform: translateY(-8px) scale(0.96);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	/* Project header in dropdown */
	.swarm-project-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.75rem;
		background: var(--color-base-300);
		border-bottom: 1px solid color-mix(in oklch, var(--color-base-content) 25%, transparent);
		position: sticky;
		top: 0;
		z-index: 1;
	}

	.swarm-project-label {
		font-size: 0.65rem;
		font-weight: 600;
		color: var(--color-warning);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-family: ui-monospace, monospace;
		flex: 1;
	}

	.swarm-project-count {
		font-size: 0.6rem;
		color: var(--color-base-content);
		opacity: 0.5;
		padding: 0.125rem 0.375rem;
		background: var(--color-base-200);
		border-radius: 8px;
	}

	/* Project tab selector */
	.project-tab {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		background: var(--color-base-200);
		border: 1px solid color-mix(in oklch, var(--color-base-content) 28%, transparent);
		border-radius: 0.25rem;
		color: var(--color-base-content);
		opacity: 0.6;
		cursor: pointer;
		transition: all 0.15s ease;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.project-tab:hover {
		background: var(--color-base-300);
		border-color: color-mix(in oklch, var(--color-base-content) 35%, transparent);
		opacity: 0.75;
	}

	.project-tab-active {
		background: var(--color-success);
		border-color: var(--color-success);
		color: var(--color-success-content);
		opacity: 1;
	}

	.project-tab-active:hover {
		background: color-mix(in oklch, var(--color-success) 85%, var(--color-base-100));
		border-color: var(--color-success);
	}

	.project-tab-count {
		font-size: 0.55rem;
		padding: 0 0.25rem;
		background: var(--color-base-100);
		border-radius: 4px;
		color: var(--color-base-content);
		opacity: 0.55;
	}

	.project-tab-active .project-tab-count {
		background: color-mix(in oklch, var(--color-success-content) 20%, transparent);
		color: var(--color-success-content);
		opacity: 0.85;
	}

	/* Task row in dropdown */
	.swarm-task-row {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid color-mix(in oklch, var(--color-base-content) 10%, transparent);
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.swarm-task-row:last-of-type {
		border-bottom: none;
	}

	.swarm-task-row:hover:not(:disabled) {
		background: var(--color-base-300);
	}

	.swarm-task-row:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Menu item in dropdown (Quick Actions) */
	.swarm-menu-item {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: transparent;
		border: none;
		border-radius: 0.375rem;
		color: var(--color-base-content);
		opacity: 0.8;
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
		cursor: pointer;
		transition: all 0.15s ease;
		text-align: left;
	}

	.swarm-menu-item:hover:not(:disabled) {
		background: var(--color-base-300);
		opacity: 0.9;
	}

	.swarm-menu-item:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.swarm-menu-item svg {
		color: var(--color-success);
		flex-shrink: 0;
	}

	.swarm-menu-item:hover:not(:disabled) svg {
		color: var(--color-success);
		opacity: 1;
	}
</style>
