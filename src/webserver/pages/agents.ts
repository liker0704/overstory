import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../../agents/types.ts";
import type { DashboardData } from "../../dashboard/data.ts";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { html, layout, Raw } from "../templates/layout.ts";
import { agentTreeNode, emptyState } from "../templates/partials.ts";

const AGENT_TREE_CSS = `<style>
.agent-tree { list-style: none; padding: 0; margin: 0; }
.agent-tree .agent-tree { padding-left: 24px; }
.agent-tree-node { position: relative; padding: 6px 0 6px 20px; }
.agent-tree-node::before { content: ""; border-left: 1px solid var(--border); position: absolute; left: 0; top: 0; bottom: 0; }
.agent-tree-node::after { content: ""; border-top: 1px solid var(--border); position: absolute; left: 0; top: 18px; width: 16px; }
.agent-tree-node:last-child::before { bottom: calc(100% - 18px); }
.agent-tree > .agent-tree-node::before, .agent-tree > .agent-tree-node::after { display: none; }
.agent-tree-content { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 0.9rem; }
.agent-tree-content:hover { background: var(--surface); }
.agent-tree-name { font-weight: 500; }
.agent-tree-name a { color: inherit; text-decoration: none; }
.agent-tree-name a:hover { color: var(--blue); text-decoration: underline; }
.agent-tree-meta { color: var(--text-muted); font-size: 0.8rem; }
.agent-tree-warning { color: var(--amber); font-size: 0.75rem; font-weight: 500; }
.status-working { background: var(--green); box-shadow: 0 0 6px var(--green); }
.status-booting { background: var(--amber); box-shadow: 0 0 6px var(--amber); }
.status-stopped { background: var(--text-muted); }
@media (max-width: 768px) {
  .agent-tree .agent-tree { padding-left: 0; }
  .agent-tree-node::before, .agent-tree-node::after { display: none; }
  .agent-tree-node { padding-left: 0; }
}
</style>`;

interface TreeNode {
	agent: AgentSession;
	children: TreeNode[];
	cycleWarning?: boolean;
}

function detectCycles(agents: AgentSession[]): Set<string> {
	const parentMap = new Map<string, string | null>();
	for (const a of agents) {
		parentMap.set(a.agentName, a.parentAgent);
	}

	const visited = new Set<string>();
	const inStack = new Set<string>();
	const cycleNodes = new Set<string>();

	function dfs(name: string): void {
		if (inStack.has(name)) {
			cycleNodes.add(name);
			return;
		}
		if (visited.has(name)) return;
		visited.add(name);
		inStack.add(name);
		const parent = parentMap.get(name);
		if (parent != null && parentMap.has(parent)) {
			dfs(parent);
		}
		inStack.delete(name);
	}

	for (const a of agents) {
		if (!visited.has(a.agentName)) {
			dfs(a.agentName);
		}
	}

	return cycleNodes;
}

function buildTree(agents: AgentSession[]): TreeNode[] {
	const cycleNodes = detectCycles(agents);
	const byName = new Map<string, AgentSession>();
	for (const a of agents) {
		byName.set(a.agentName, a);
	}

	const sorted = [...agents].sort((a, b) => {
		const aActive = a.state === "booting" || a.state === "working" ? 0 : 1;
		const bActive = b.state === "booting" || b.state === "working" ? 0 : 1;
		if (aActive !== bActive) return aActive - bActive;
		return b.lastActivity.localeCompare(a.lastActivity);
	});

	const nodeMap = new Map<string, TreeNode>();
	const childrenMap = new Map<string, TreeNode[]>();
	const roots: TreeNode[] = [];

	for (const agent of sorted) {
		const node: TreeNode = { agent, children: [] };
		nodeMap.set(agent.agentName, node);
		childrenMap.set(agent.agentName, node.children);
	}

	for (const agent of sorted) {
		const node = nodeMap.get(agent.agentName);
		if (!node) continue;
		const isRoot =
			agent.parentAgent == null ||
			!byName.has(agent.parentAgent) ||
			cycleNodes.has(agent.agentName);
		if (isRoot) {
			if (cycleNodes.has(agent.agentName)) node.cycleWarning = true;
			roots.push(node);
		} else {
			const parentChildren = childrenMap.get(agent.parentAgent ?? "");
			if (parentChildren) parentChildren.push(node);
		}
	}

	return roots;
}

function renderTreeNodes(nodes: TreeNode[]): string {
	if (nodes.length === 0) return "";
	return nodes
		.map((node) => {
			const nodeHtml = agentTreeNode(node.agent, node.cycleWarning).value;
			const subtree =
				node.children.length > 0
					? `<ul class="agent-tree">${renderTreeNodes(node.children)}</ul>`
					: "";
			return `${nodeHtml}${subtree}</li>`;
		})
		.join("\n");
}

const REGISTRY_PATH = join(homedir(), ".overstory", "projects.json");

async function resolveProjectPath(
	slug: string,
): Promise<{ projectPath: string } | { notFound: true }> {
	const registry = await loadRegistry(REGISTRY_PATH);
	const project = registry.projects.find((p) => p.slug === slug);
	if (!project) return { notFound: true };
	return { projectPath: project.path };
}

export function renderAgentsPanel(data: DashboardData): string {
	if (data.status.agents.length === 0) {
		return emptyState("No agents found.").value;
	}

	const roots = buildTree(data.status.agents);
	const treeHtml = renderTreeNodes(roots);
	return AGENT_TREE_CSS + html`<ul class="agent-tree">${new Raw(treeHtml)}</ul>`.value;
}

export async function handleAgentsPage(
	_req: Request,
	params: Record<string, string>,
): Promise<Response> {
	const slug = params.slug ?? "";
	const resolved = await resolveProjectPath(slug);

	if ("notFound" in resolved) {
		const body = layout("Not Found", html`<h1>Project not found</h1>`, { slug });
		return new Response(body, {
			status: 404,
			headers: { "Content-Type": "text/html" },
		});
	}

	const { projectPath } = resolved;
	const stores = await acquireStores(projectPath);
	try {
		const data = await loadDashboardData(projectPath, stores);
		const panelHtml = renderAgentsPanel(data);
		const content = html`<div id="sse-agents" sse-swap="agents">${new Raw(panelHtml)}</div>`;

		const htmlString = layout(`Overstory — ${slug} — Agents`, content, {
			activeNav: "Agents",
			slug,
		});
		return new Response(htmlString, {
			status: 200,
			headers: { "Content-Type": "text/html" },
		});
	} finally {
		releaseStores(projectPath);
	}
}
