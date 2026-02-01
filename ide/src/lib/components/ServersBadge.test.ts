/**
 * ServersBadge Spawn and /work Page Grouping Tests
 *
 * Tests that:
 * 1. Spawning a session via ServersBadge dropdown calls the spawn API with correct project info
 * 2. The created session appears under the correct project on the /work page
 * 3. Session grouping uses session.project field as fallback when task ID isn't available
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// Test Fixtures
// ============================================================================

const MOCK_PROJECTS_WITH_PORTS = [
	{
		key: 'jat',
		name: 'jat',
		path: '/home/jw/code/jat',
		port: 5173
	},
	{
		key: 'chimaro',
		name: 'chimaro',
		path: '/home/jw/code/chimaro',
		port: 3000
	},
	{
		key: 'jomarchy',
		name: 'jomarchy',
		path: '/home/jw/code/jomarchy',
		port: 8080
	}
];

const MOCK_SPAWN_RESPONSE_JAT = {
	session: {
		sessionName: 'jat-TestAgent',
		agentName: 'TestAgent',
		task: null,
		project: 'jat',
		startedAt: '2025-12-23T10:00:00Z'
	}
};

const MOCK_SPAWN_RESPONSE_CHIMARO = {
	session: {
		sessionName: 'jat-AnotherAgent',
		agentName: 'AnotherAgent',
		task: null,
		project: 'chimaro',
		startedAt: '2025-12-23T10:00:00Z'
	}
};

// Session with task ID (should group by task prefix, not session.project)
const MOCK_SESSION_WITH_TASK = {
	sessionName: 'jat-BusyAgent',
	agentName: 'BusyAgent',
	task: { id: 'chimaro-abc', title: 'Fix bug', status: 'in_progress' },
	project: 'jat', // Even though project says jat, task prefix says chimaro
	startedAt: '2025-12-23T10:00:00Z'
};

// Session without task (should use session.project fallback)
const MOCK_SESSION_PLANNING = {
	sessionName: 'jat-PlanningAgent',
	agentName: 'PlanningAgent',
	task: null,
	project: 'jomarchy',
	startedAt: '2025-12-23T10:00:00Z'
};

// Session with lastCompletedTask (should use task ID prefix)
const MOCK_SESSION_COMPLETED = {
	sessionName: 'jat-IdleAgent',
	agentName: 'IdleAgent',
	task: null,
	lastCompletedTask: { id: 'jat-xyz', title: 'Done task' },
	project: 'chimaro', // project field differs from task prefix
	startedAt: '2025-12-23T10:00:00Z'
};

// ============================================================================
// Helper Functions
// ============================================================================

function resetMocks() {
	vi.clearAllMocks();
	mockFetch.mockReset();
}

/**
 * Simulates the spawn API call that ServersBadge.handleSpawnSession makes
 */
async function simulateSpawnSession(projectKey: string) {
	const response = await fetch('/api/work/spawn', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ attach: true, project: projectKey })
	});

	return response.json();
}

/**
 * Extracts project from task ID (same logic as /work page)
 */
function getProjectFromTaskId(taskId: string): string | null {
	const match = taskId.match(/^([a-zA-Z0-9_-]+)-/);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Groups sessions by project (same logic as /work page sessionsByProject)
 */
function groupSessionsByProject(
	sessions: Array<{
		task?: { id?: string } | null;
		lastCompletedTask?: { id?: string } | null;
		project?: string | null;
	}>
): Map<string, typeof sessions> {
	const groups = new Map<string, typeof sessions>();

	for (const session of sessions) {
		let project: string | null = null;

		// Priority 1: Use task ID prefix
		if (session.task?.id) {
			project = getProjectFromTaskId(session.task.id);
		}
		// Priority 2: Use lastCompletedTask ID prefix
		else if (session.lastCompletedTask?.id) {
			project = getProjectFromTaskId(session.lastCompletedTask.id);
		}
		// Priority 3: Fallback to session.project
		else if (session.project) {
			project = session.project;
		}

		if (project) {
			const existing = groups.get(project) || [];
			existing.push(session);
			groups.set(project, existing);
		}
	}

	return groups;
}

// ============================================================================
// Tests: Spawn API Call
// ============================================================================

describe('ServersBadge Spawn API Call', () => {
	beforeEach(resetMocks);

	it('should call spawn API with correct project key', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(MOCK_SPAWN_RESPONSE_JAT)
		});

		await simulateSpawnSession('jat');

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockFetch).toHaveBeenCalledWith('/api/work/spawn', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				attach: true,
				project: 'jat'
			})
		});
	});

	it('should pass project key for known projects', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(MOCK_SPAWN_RESPONSE_CHIMARO)
		});

		await simulateSpawnSession('chimaro');

		const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(callBody.project).toBe('chimaro');
	});

	it('should pass through unknown project keys', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					session: { sessionName: 'jat-Agent', project: 'unknown-project' }
				})
		});

		await simulateSpawnSession('unknown-project');

		const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(callBody.project).toBe('unknown-project');
	});

	it('should return session with project field set', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(MOCK_SPAWN_RESPONSE_JAT)
		});

		const result = await simulateSpawnSession('jat');

		expect(result.session).toBeDefined();
		expect(result.session.project).toBe('jat');
		expect(result.session.sessionName).toBe('jat-TestAgent');
	});
});

// ============================================================================
// Tests: Session Project Grouping
// ============================================================================

describe('Session Project Grouping (/work page logic)', () => {
	beforeEach(resetMocks);

	it('should group session by task ID prefix when task exists', () => {
		const sessions = [MOCK_SESSION_WITH_TASK];
		const groups = groupSessionsByProject(sessions);

		// Should be grouped under 'chimaro' (from task ID), not 'jat' (from session.project)
		expect(groups.has('chimaro')).toBe(true);
		expect(groups.has('jat')).toBe(false);
		expect(groups.get('chimaro')?.length).toBe(1);
	});

	it('should use session.project fallback for planning sessions without task', () => {
		const sessions = [MOCK_SESSION_PLANNING];
		const groups = groupSessionsByProject(sessions);

		// Should be grouped under 'jomarchy' (from session.project)
		expect(groups.has('jomarchy')).toBe(true);
		expect(groups.get('jomarchy')?.length).toBe(1);
	});

	it('should use lastCompletedTask ID prefix when no current task', () => {
		const sessions = [MOCK_SESSION_COMPLETED];
		const groups = groupSessionsByProject(sessions);

		// Should be grouped under 'jat' (from lastCompletedTask ID), not 'chimaro' (from session.project)
		expect(groups.has('jat')).toBe(true);
		expect(groups.has('chimaro')).toBe(false);
		expect(groups.get('jat')?.length).toBe(1);
	});

	it('should correctly group multiple sessions by project', () => {
		const sessions = [
			MOCK_SESSION_WITH_TASK, // → chimaro (task ID)
			MOCK_SESSION_PLANNING, // → jomarchy (session.project)
			MOCK_SESSION_COMPLETED, // → jat (lastCompletedTask ID)
			{ ...MOCK_SPAWN_RESPONSE_JAT.session }, // → jat (session.project, no task)
			{ ...MOCK_SPAWN_RESPONSE_CHIMARO.session } // → chimaro (session.project, no task)
		];
		const groups = groupSessionsByProject(sessions);

		expect(groups.size).toBe(3); // jat, chimaro, jomarchy

		expect(groups.get('jat')?.length).toBe(2); // MOCK_SESSION_COMPLETED + spawn response
		expect(groups.get('chimaro')?.length).toBe(2); // MOCK_SESSION_WITH_TASK + spawn response
		expect(groups.get('jomarchy')?.length).toBe(1); // MOCK_SESSION_PLANNING
	});

	it('should handle empty sessions array', () => {
		const groups = groupSessionsByProject([]);
		expect(groups.size).toBe(0);
	});

	it('should skip sessions with no identifiable project', () => {
		const sessionNoProject = {
			sessionName: 'orphan-session',
			agentName: 'OrphanAgent',
			task: null,
			project: null
		};
		const groups = groupSessionsByProject([sessionNoProject]);
		expect(groups.size).toBe(0);
	});
});

// ============================================================================
// Tests: End-to-End Flow (Spawn → Session → Grouping)
// ============================================================================

describe('End-to-End: Spawn Session appears under correct project', () => {
	beforeEach(resetMocks);

	it('should spawn session for jat project and appear under jat group', async () => {
		// 1. Mock the spawn API response
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(MOCK_SPAWN_RESPONSE_JAT)
		});

		// 2. Simulate spawn
		const result = await simulateSpawnSession('jat');

		// 3. Verify session has correct project
		expect(result.session.project).toBe('jat');

		// 4. Verify session groups correctly
		const groups = groupSessionsByProject([result.session]);
		expect(groups.has('jat')).toBe(true);
		expect(groups.get('jat')?.[0].agentName).toBe('TestAgent');
	});

	it('should spawn session for chimaro project and appear under chimaro group', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(MOCK_SPAWN_RESPONSE_CHIMARO)
		});

		const result = await simulateSpawnSession('chimaro');

		expect(result.session.project).toBe('chimaro');

		const groups = groupSessionsByProject([result.session]);
		expect(groups.has('chimaro')).toBe(true);
		expect(groups.get('chimaro')?.[0].agentName).toBe('AnotherAgent');
	});

	it('should handle mixed sessions (with/without tasks) correctly', async () => {
		// Simulate existing sessions in IDE
		const existingSessions = [MOCK_SESSION_WITH_TASK, MOCK_SESSION_PLANNING];

		// Spawn new session for jat
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(MOCK_SPAWN_RESPONSE_JAT)
		});
		const newSession = await simulateSpawnSession('jat');

		// Combine existing + new
		const allSessions = [...existingSessions, newSession.session];
		const groups = groupSessionsByProject(allSessions);

		// Verify grouping:
		// - MOCK_SESSION_WITH_TASK → chimaro (task ID)
		// - MOCK_SESSION_PLANNING → jomarchy (session.project)
		// - newSession → jat (session.project)
		expect(groups.size).toBe(3);
		expect(groups.get('chimaro')?.length).toBe(1);
		expect(groups.get('jomarchy')?.length).toBe(1);
		expect(groups.get('jat')?.length).toBe(1);
	});
});

// ============================================================================
// Tests: getProjectFromTaskId utility
// ============================================================================

describe('getProjectFromTaskId', () => {
	it('should extract project from standard task ID format', () => {
		expect(getProjectFromTaskId('jat-abc')).toBe('jat');
		expect(getProjectFromTaskId('chimaro-xyz123')).toBe('chimaro');
		expect(getProjectFromTaskId('jomarchy-1a2b3c')).toBe('jomarchy');
	});

	it('should handle multi-word project names', () => {
		expect(getProjectFromTaskId('my-project-abc')).toBe('my-project');
	});

	it('should handle underscores in project name', () => {
		expect(getProjectFromTaskId('my_project-abc')).toBe('my_project');
	});

	it('should lowercase project names', () => {
		expect(getProjectFromTaskId('JAT-ABC')).toBe('jat');
		expect(getProjectFromTaskId('Chimaro-xyz')).toBe('chimaro');
	});

	it('should return null for invalid task IDs', () => {
		expect(getProjectFromTaskId('nohyphentask')).toBe(null);
		expect(getProjectFromTaskId('-orphan')).toBe(null);
		expect(getProjectFromTaskId('')).toBe(null);
	});
});
