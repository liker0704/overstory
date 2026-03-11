/**
 * ReviewStore interface used by the staleness module.
 *
 * The full implementation is provided by review-store-builder.
 * This file defines only the interface contract needed for compilation.
 */

import type {
	InsertReviewRecord,
	ReviewRecord,
	ReviewSubjectType,
	ReviewSummary,
	StalenessState,
} from "./types.ts";

export interface ReviewStore {
	insert(record: InsertReviewRecord): ReviewRecord;
	getById(id: string): ReviewRecord | null;
	getByType(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewRecord[];
	getLatest(subjectType: ReviewSubjectType, subjectId: string): ReviewRecord | null;
	getStale(): ReviewRecord[];
	markStale(subjectType: ReviewSubjectType, reason: string): number;
	markStaleById(id: string, reason: string): void;
	getSummary(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewSummary;
	saveStalenessState(state: StalenessState): void;
	loadStalenessState(): StalenessState | null;
	close(): void;
}
