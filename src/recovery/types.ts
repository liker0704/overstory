import type {
	AgentIdentity,
	AgentSession,
	MailMessage,
	MergeEntry,
	Mission,
	Run,
	SessionCheckpoint,
	SessionHandoff,
} from "../types.ts";

export interface WorktreeStatus {
	path: string;
	branch: string;
	head: string;
	exists: boolean;
	hasUncommittedChanges: boolean;
}

export interface SwarmSnapshot {
	snapshotId: string;
	formatVersion: 1;
	createdAt: string;
	projectRoot: string;
	runId: string | null;
	missionId: string | null;
	sessions: AgentSession[];
	runs: Run[];
	missions: Mission[];
	mail: MailMessage[];
	mergeQueue: MergeEntry[];
	checkpoints: Record<string, SessionCheckpoint>;
	handoffs: Record<string, SessionHandoff[]>;
	identities: Record<string, AgentIdentity>;
	worktreeStatus: WorktreeStatus[];
	metadata: {
		currentRunFile: string | null;
		sessionBranchFile: string | null;
		configHash: string | null;
	};
}

export interface RecoveryBundleManifest {
	bundleId: string;
	formatVersion: 1;
	createdAt: string;
	snapshotId: string;
	files: Array<{
		name: string;
		description: string;
		sizeBytes: number;
	}>;
}

export type ComponentRestoreStatus = "restored" | "degraded" | "missing" | "skipped";

export type ReconciliationStatus = "restored" | "partial" | "failed";

export interface ReconciliationReport {
	bundleId: string;
	restoredAt: string;
	components: Array<{
		name: string;
		status: ComponentRestoreStatus;
		details: string;
	}>;
	overallStatus: ReconciliationStatus;
	operatorActions: string[];
}

export interface SnapshotOptions {
	outputDir?: string;
	agentFilter?: string[];
	includeCompleted?: boolean;
}

export interface RestoreOptions {
	bundlePath: string;
	skipWorktrees?: boolean;
	dryRun?: boolean;
}
