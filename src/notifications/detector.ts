import type { EventStore } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import {
	type DashboardNotification,
	DEFAULT_NOTIFICATION_CONFIG,
	type NotificationConfig,
} from "./types.ts";

export class NotificationDetector {
	private readonly config: NotificationConfig;

	/** createdAt of the last mail message we've processed. */
	private mailLastSeenTimestamp: string | null = null;
	/** id of the last event we've processed. */
	private eventLastSeenId: number = 0;
	/** createdAt of the last event we've processed. */
	private eventLastSeenTimestamp: string | null = null;

	constructor(config?: NotificationConfig) {
		this.config = config ?? DEFAULT_NOTIFICATION_CONFIG;
	}

	/** Poll for new notifications since the last call. Returns most-recent first, capped at maxPerTick. */
	poll(mailStore: MailStore | null, eventStore: EventStore | null): DashboardNotification[] {
		const notifications: DashboardNotification[] = [];

		notifications.push(...this._pollMail(mailStore));
		notifications.push(...this._pollEvents(eventStore));

		// Sort most recent first
		notifications.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

		return notifications.slice(0, this.config.maxPerTick);
	}

	private _pollMail(mailStore: MailStore | null): DashboardNotification[] {
		if (!mailStore) return [];

		const messages = mailStore.getAll({ limit: 100 });
		const lastSeen = this.mailLastSeenTimestamp;

		const newMessages = lastSeen ? messages.filter((m) => m.createdAt > lastSeen) : messages;

		const notifications: DashboardNotification[] = [];

		for (const msg of newMessages) {
			if (msg.type === "error") {
				notifications.push({
					id: `notif-mail-${msg.id}`,
					kind: "error",
					title: msg.subject,
					body: msg.body,
					severity: "high",
					timestamp: msg.createdAt,
				});
			} else if (msg.type === "worker_done") {
				notifications.push({
					id: `notif-mail-${msg.id}`,
					kind: "completion",
					title: `Worker completed: ${msg.from}`,
					body: msg.subject,
					severity: "medium",
					timestamp: msg.createdAt,
				});
			} else if (msg.type === "result") {
				notifications.push({
					id: `notif-mail-${msg.id}`,
					kind: "completion",
					title: `Result from ${msg.from}`,
					body: msg.subject,
					severity: "low",
					timestamp: msg.createdAt,
				});
			}
		}

		// Update watermark to most recent message we saw
		if (newMessages.length > 0) {
			let maxTimestamp = this.mailLastSeenTimestamp ?? "";
			for (const msg of newMessages) {
				if (msg.createdAt > maxTimestamp) {
					maxTimestamp = msg.createdAt;
				}
			}
			this.mailLastSeenTimestamp = maxTimestamp;
		}

		return notifications;
	}

	private _pollEvents(eventStore: EventStore | null): DashboardNotification[] {
		if (!eventStore) return [];

		const sinceTimestamp = this.eventLastSeenTimestamp ?? "1970-01-01T00:00:00.000Z";
		const events = eventStore.getTimeline({ since: sinceTimestamp, limit: 100 });

		const lastSeenId = this.eventLastSeenId;
		const newEvents = events.filter((e) => e.id > lastSeenId);

		const notifications: DashboardNotification[] = [];

		for (const evt of newEvents) {
			if (evt.level === "error") {
				const dataPreview = evt.data ? evt.data.slice(0, 100) : "";
				notifications.push({
					id: `notif-event-${evt.id}`,
					kind: "error",
					title: `Error: ${evt.agentName}`,
					body: `${evt.eventType}: ${dataPreview}`,
					severity: "high",
					timestamp: evt.createdAt,
				});
			} else if (evt.eventType === "spawn") {
				notifications.push({
					id: `notif-event-${evt.id}`,
					kind: "info",
					title: `Agent spawned: ${evt.agentName}`,
					body: evt.data ?? "",
					severity: "low",
					timestamp: evt.createdAt,
				});
			}
		}

		// Update watermarks
		if (newEvents.length > 0) {
			let maxId = this.eventLastSeenId;
			let maxTimestamp = this.eventLastSeenTimestamp ?? "";
			for (const evt of newEvents) {
				if (evt.id > maxId) maxId = evt.id;
				if (evt.createdAt > maxTimestamp) maxTimestamp = evt.createdAt;
			}
			this.eventLastSeenId = maxId;
			this.eventLastSeenTimestamp = maxTimestamp;
		}

		return notifications;
	}
}

export function createNotificationDetector(config?: NotificationConfig): NotificationDetector {
	return new NotificationDetector(config);
}
