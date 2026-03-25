/**
 * Notification detector for the dashboard.
 * Stub — canonical implementation lives in notif-types-builder branch.
 */

import type { EventStore } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import type { DashboardNotification, NotificationConfig } from "./types.ts";

export interface NotificationDetector {
	poll(mailStore: MailStore | null, eventStore: EventStore | null): DashboardNotification[];
}

export function createNotificationDetector(_config?: NotificationConfig): NotificationDetector {
	return {
		poll(_mailStore: MailStore | null, _eventStore: EventStore | null): DashboardNotification[] {
			return [];
		},
	};
}
