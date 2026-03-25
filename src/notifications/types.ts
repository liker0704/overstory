/**
 * Notification types for the dashboard.
 * Stub — canonical implementation lives in notif-types-builder branch.
 */

export type NotificationSeverity = "info" | "warning" | "error";

export interface DashboardNotification {
	id: string;
	type: string;
	severity: NotificationSeverity;
	title: string;
	body: string;
	agentName?: string;
	createdAt: string;
}

export interface NotificationConfig {
	maxAge?: number;
}
