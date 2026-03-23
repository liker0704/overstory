import type { StoredEvent } from "../events/types.ts";
import type {
	AggregateStats,
	Assertion,
	EventSelector,
	StochasticAssertionResult,
	TrialResult,
} from "./types.ts";

function matchesSelector(event: StoredEvent, selector: EventSelector): boolean {
	if (event.eventType !== selector.eventType) return false;
	if (selector.agentName !== undefined && event.agentName !== selector.agentName) return false;
	if (selector.dataMatch !== undefined && !(event.data ?? "").includes(selector.dataMatch))
		return false;
	return true;
}

/**
 * Evaluate stochastic assertions against aggregate stats and per-trial results.
 */
export function evaluateStochasticAssertions(
	assertions: Assertion[],
	aggregateStats: AggregateStats,
	trials: TrialResult[],
): StochasticAssertionResult[] {
	return assertions.map((assertion) => {
		const label = assertion.label ?? assertion.kind;
		const expected = assertion.expected as number;

		if (assertion.kind === "success_ratio") {
			const actual = aggregateStats.successRatio;
			const passed = actual >= expected;
			return {
				kind: assertion.kind,
				label,
				passed,
				actual,
				expected,
				message: passed
					? `Success ratio ${actual} >= ${expected}`
					: `Success ratio ${actual} < ${expected}`,
			};
		}

		if (assertion.kind === "percentile_bound") {
			const metricName = assertion.metric!;
			const metricAggregate = aggregateStats.metrics[metricName];
			if (metricAggregate === undefined) {
				return {
					kind: assertion.kind,
					label,
					passed: false,
					actual: 0,
					expected,
					message: `Metric '${metricName}' not found in aggregate stats`,
				};
			}
			const pKey = `p${assertion.percentile}` as keyof typeof metricAggregate;
			const percentileValue = metricAggregate[pKey] as number;
			const passed = percentileValue <= expected;
			return {
				kind: assertion.kind,
				label,
				passed,
				actual: percentileValue,
				expected,
				message: passed
					? `p${assertion.percentile} ${percentileValue} <= ${expected}`
					: `p${assertion.percentile} ${percentileValue} > ${expected}`,
			};
		}

		if (assertion.kind === "max_retry_frequency") {
			const selector = assertion.selector!;
			if (trials.length === 0) {
				return {
					kind: assertion.kind,
					label,
					passed: true,
					actual: 0,
					expected,
					message: `Retry frequency 0 <= ${expected}`,
				};
			}
			let matchingTrials = 0;
			for (const trial of trials) {
				const events = trial.evalResult.context?.events ?? [];
				const hasMatch = events.some((event) => matchesSelector(event, selector));
				if (hasMatch) matchingTrials++;
			}
			const actual = matchingTrials / trials.length;
			const passed = actual <= expected;
			return {
				kind: assertion.kind,
				label,
				passed,
				actual,
				expected,
				message: passed
					? `Retry frequency ${actual} <= ${expected}`
					: `Retry frequency ${actual} > ${expected}`,
			};
		}

		return {
			kind: assertion.kind,
			label,
			passed: false,
			actual: 0,
			expected,
			message: `Unknown stochastic assertion kind: ${assertion.kind}`,
		};
	});
}
