/** Notification kinds for dashboard events. */
export type NotificationKind = "error" | "completion" | "health_alert" | "info";

/** All valid notification kinds as a runtime array. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
	"error",
	"completion",
	"health_alert",
	"info",
] as const;

/** Severity levels for notifications. */
export type NotificationSeverity = "low" | "medium" | "high" | "critical";

/** A notification derived from mail/event store data for the dashboard. */
export interface DashboardNotification {
	id: string;
	kind: NotificationKind;
	title: string;
	body: string;
	severity: NotificationSeverity;
	timestamp: string; // ISO timestamp
}

/** Configuration for the notification detector. */
export interface NotificationConfig {
	/** Maximum notifications returned per poll tick. */
	maxPerTick: number;
}

/** Default notification configuration. */
export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
	maxPerTick: 50,
};
