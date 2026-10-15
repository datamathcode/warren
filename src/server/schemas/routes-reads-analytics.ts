/**
 * Batch 2 analytics and the operations snapshot. Operator bodies are
 * strict. Fields a public spectator does not receive are optional.
 */

import * as z from "zod";
import { INSIGHT_CONFIDENCES, OPS_WINDOWS } from "../../core/wire.ts";
import {
	pullRequestLifecycleSchema,
	runFailureReasonSchema,
	runStateSchema,
} from "./components.ts";
import { defineRoute, type RouteContract } from "./registry.ts";

const nullableNumber = z.number().nullable();

const statSummary = z.strictObject({
	avg: nullableNumber,
	median: nullableNumber,
	p95: nullableNumber,
	count: z.number().int(),
});

const tokenBreakdown = z.strictObject({
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
	total: z.number(),
});

const analyticsFilter = z.strictObject({
	projectId: z.string().nullable(),
	from: z.string().nullable(),
	to: z.string().nullable(),
});

const runStateCounts = z.strictObject({
	queued: z.number(),
	running: z.number(),
	succeeded: z.number(),
	failed: z.number(),
	cancelled: z.number(),
});

const opsOverview = defineRoute("GET", "/ops/overview", {
	response: z.strictObject({
		runs: z.strictObject({
			byState: runStateCounts,
			nonTerminal: z.number(),
			total: z.number(),
		}),
		window: z.enum(OPS_WINDOWS),
		spend: z.strictObject({
			// USD sums are operator-only.
			totalUsd: z.number().optional(),
			windowUsd: z.number().optional(),
			windowRuns: z.number(),
		}),
		delivery: z.strictObject({
			branchesPushed: z.number(),
			prsOpened: z.number(),
			prsMerged: z.number(),
		}),
		services: z.strictObject({
			dbReachable: z.boolean(),
			runtime: z.enum(["local", "k8s", "docker"]),
			lifecycleStream: z.boolean(),
		}),
		generatedAt: z.string(),
	}),
	responseComponent: "OpsOverview",
});

const costBucket = z.strictObject({
	key: z.string(),
	costUsd: z.number(),
	runs: z.number(),
	priced: z.number(),
});

const costBasisBucket = z.strictObject({
	key: z.enum(["api", "subscription_estimate", "unpriced"]),
	runs: z.number(),
	costUsd: z.number(),
});

const costAnalytics = defineRoute("GET", "/analytics/cost", {
	response: z.strictObject({
		filter: analyticsFilter,
		totals: z.strictObject({
			runs: z.number(),
			priced: z.number(),
			costUsd: z.number(),
		}),
		breakdowns: z.strictObject({
			date: z.array(costBucket),
			project: z.array(costBucket),
			plan: z.array(costBucket),
			run: z.array(costBucket),
			agent: z.array(costBucket),
			model: z.array(costBucket),
			provider: z.array(costBucket),
		}),
		byCostBasis: z.array(costBasisBucket),
	}),
	responseComponent: "CostAnalytics",
});

const runGroupBucket = z.strictObject({
	key: z.string(),
	runs: z.number(),
	succeeded: z.number(),
	failed: z.number(),
	cancelled: z.number(),
	successRate: nullableNumber,
	prStateKnown: z.number(),
	prsMerged: z.number(),
	mergedPrRate: nullableNumber,
	contextTokensTotal: z.number(),
	avgContextTokens: nullableNumber,
	tokens: tokenBreakdown,
	costUsd: z.number(),
	priced: z.number(),
	avgDurationMs: nullableNumber,
});

const dayBucket = z.strictObject({
	key: z.string(),
	runs: z.number(),
	succeeded: z.number(),
	failed: z.number(),
	cancelled: z.number(),
	active: z.number(),
	contextTokensTotal: z.number(),
});

const tokenDay = z.strictObject({
	date: z.string(),
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
	total: z.number(),
});

const dimensionTokenSeries = z.strictObject({
	key: z.string(),
	series: z.array(tokenDay),
});

const outcomeTally = z.strictObject({
	runs: z.number(),
	terminal: z.number(),
	succeeded: z.number(),
	successRate: nullableNumber,
	prStateKnown: z.number(),
	prsMerged: z.number(),
	mergedPrRate: nullableNumber,
});

const costPerMergedBucket = z.strictObject({
	key: z.string(),
	costUsd: z.number(),
	priced: z.number(),
	prStateKnown: z.number(),
	prsMerged: z.number(),
	costPerMergedPrUsd: nullableNumber,
});

const runOutcomes = z.strictObject({
	steering: z.strictObject({
		steered: outcomeTally,
		unsteered: outcomeTally,
		mergedPrRateDelta: nullableNumber,
		confidence: z.enum(INSIGHT_CONFIDENCES),
	}),
	costPerMergedPr: z.strictObject({
		overall: z.strictObject({
			costUsd: z.number(),
			priced: z.number(),
			prStateKnown: z.number(),
			prsMerged: z.number(),
			costPerMergedPrUsd: nullableNumber,
		}),
		byAgent: z.array(costPerMergedBucket),
		byModel: z.array(costPerMergedBucket),
		byProvider: z.array(costPerMergedBucket),
		confidence: z.enum(INSIGHT_CONFIDENCES),
	}),
	autonomy: z.strictObject({
		merged: z.number(),
		autonomous: z.number(),
		rate: nullableNumber,
	}),
});

const runAnalytics = defineRoute("GET", "/analytics/runs", {
	response: z.strictObject({
		filter: analyticsFilter,
		totals: z.strictObject({
			runs: z.number(),
			succeeded: z.number(),
			failed: z.number(),
			cancelled: z.number(),
			active: z.number(),
			successRate: nullableNumber,
			prStateKnown: z.number(),
			prsMerged: z.number(),
			mergedPrRate: nullableNumber,
			durationMs: statSummary,
			queueWaitMs: statSummary,
			contextTokens: statSummary,
			tokens: tokenBreakdown,
			costUsd: statSummary,
			cost: z.strictObject({
				total: z.number(),
				avg: nullableNumber,
				priced: z.number(),
			}),
		}),
		delivery: z.strictObject({
			branchPushToPrOpenMs: statSummary,
			prOpenToMergeMs: statSummary,
			dispatchToMergeMs: statSummary,
			endToMergeMs: statSummary,
		}),
		timeSeries: z.array(dayBucket),
		byAgent: z.array(runGroupBucket),
		byModel: z.array(runGroupBucket),
		byProvider: z.array(runGroupBucket),
		byFailureReason: z.array(z.strictObject({ key: z.string(), runs: z.number() })),
		topSeedsByContext: z.array(
			z.strictObject({
				seedId: z.string(),
				runs: z.number(),
				contextTokensTotal: z.number(),
				avgContextTokens: nullableNumber,
			}),
		),
		tokenTimeSeries: z.array(tokenDay),
		tokenByModelSeries: z.array(dimensionTokenSeries),
		tokenByProviderSeries: z.array(dimensionTokenSeries),
		tokens: z.strictObject({
			totals: tokenBreakdown,
			byModel: z.array(z.strictObject({ key: z.string(), tokens: tokenBreakdown })),
			byProvider: z.array(z.strictObject({ key: z.string(), tokens: tokenBreakdown })),
			timeSeries: z.array(tokenDay),
			byModelTimeSeries: z.array(dimensionTokenSeries),
			byProviderTimeSeries: z.array(dimensionTokenSeries),
		}),
		outcomes: runOutcomes,
		capHits: z.number(),
	}),
	responseComponent: "RunAnalytics",
});

const commandStat = z.strictObject({
	command: z.string(),
	category: z.enum(["os-eco", "vcs", "package", "build", "test", "filesystem", "network", "other"]),
	osEco: z.boolean(),
	runs: z.number(),
	invocations: z.number(),
	failures: z.number(),
	failureRate: nullableNumber,
	retries: z.number(),
	stuckScore: z.number(),
});

const behavior = defineRoute("GET", "/analytics/behavior", {
	response: z.strictObject({
		filter: analyticsFilter,
		mining: z.strictObject({
			totals: z.strictObject({
				toolUses: z.number(),
				commands: z.number(),
				distinctCommands: z.number(),
				failures: z.number(),
				retries: z.number(),
				byRuntime: z.array(
					z.strictObject({
						runtime: z.string(),
						shaped: z.boolean(),
						toolUses: z.number(),
						commands: z.number(),
						unparsed: z.number(),
					}),
				),
			}),
			byFrequency: z.array(commandStat),
			byFailures: z.array(commandStat),
			byStuckScore: z.array(commandStat),
			osEcoCommands: z.array(commandStat),
			byCategory: z.array(
				z.strictObject({
					category: commandStat.shape.category,
					invocations: z.number(),
					failures: z.number(),
					commands: z.number(),
				}),
			),
		}),
		directories: z.strictObject({
			directories: z.array(
				z.strictObject({
					directory: z.string(),
					runsTouching: z.number(),
					runsFailed: z.number(),
					failureShare: nullableNumber,
					fileTouches: z.number(),
					errorTouches: z.number(),
					retries: z.number(),
					steeringMessages: z.number(),
					difficultyScore: z.number(),
					confidence: z.enum(INSIGHT_CONFIDENCES),
				}),
			),
			totals: z.strictObject({
				runsInWindow: z.number(),
				runsWithFilePaths: z.number(),
				fileTouches: z.number(),
				directoriesRanked: z.number(),
				directoriesBelowMinN: z.number(),
			}),
		}),
		insights: z.array(
			z.strictObject({
				kind: z.enum([
					"highest-context-seed",
					"worst-success-agent",
					"most-failed-command",
					"most-retried-command",
					"model-cost-outlier",
					"steering-anomaly",
					"steering-outcome-delta",
					"cost-per-merged-pr",
					"context-waste-proxy",
					"hardest-directory",
				]),
				severity: z.enum(["info", "warning", "critical"]),
				title: z.string(),
				detail: z.string(),
				value: z.number(),
				subject: z.string().nullable(),
				denominator: z.number().optional(),
				confidence: z.enum(INSIGHT_CONFIDENCES).optional(),
			}),
		),
		outcomes: runOutcomes,
		contextWaste: z.strictObject({
			runsInWindow: z.number(),
			runsWithRollup: z.number(),
			runsMeasured: z.number(),
			contextTokensTotal: z.number(),
			resultBytesTotal: z.number(),
			share: nullableNumber,
			byTool: z.array(
				z.strictObject({
					key: z.string(),
					invocations: z.number(),
					resultBytesKnown: z.number(),
					resultBytesTotal: z.number(),
					runs: z.number(),
					runsMeasured: z.number(),
					contextTokensTotal: z.number(),
					share: nullableNumber,
				}),
			),
			byCommand: z.array(
				z.strictObject({
					key: z.string(),
					invocations: z.number(),
					resultBytesKnown: z.number(),
					resultBytesTotal: z.number(),
					runs: z.number(),
					runsMeasured: z.number(),
					contextTokensTotal: z.number(),
					share: nullableNumber,
				}),
			),
			confidence: z.enum(INSIGHT_CONFIDENCES),
		}),
		truncated: z.boolean(),
	}),
	responseComponent: "BehaviorAnalytics",
});

const dispatchRow = z.strictObject({
	runId: z.string(),
	createdAt: z.string(),
	agentName: z.string().nullable(),
	provider: z.string().nullable(),
	model: z.string().nullable(),
	dispatchOrigin: z.string().nullable(),
	retryKind: z.string().nullable(),
	queueQueuedRuns: z.number().nullable(),
	queueRunningRuns: z.number().nullable(),
	queueProjectNonTerminal: z.number().nullable(),
	projectId: z.string().nullable(),
	state: runStateSchema,
	failureReason: runFailureReasonSchema.nullable(),
	costUsd: z.number().nullable(),
	prState: pullRequestLifecycleSchema.nullable(),
});

const countBucket = z.strictObject({ key: z.string(), count: z.number() });

const dispatchAnalytics = defineRoute("GET", "/analytics/dispatch", {
	response: z.strictObject({
		filter: analyticsFilter,
		totals: z.strictObject({ dispatches: z.number() }),
		byDispatchOrigin: z.array(countBucket),
		byRetryKind: z.array(countBucket),
		byProviderModel: z.array(countBucket),
		byQueueDepth: z.array(countBucket),
		rows: z.array(dispatchRow),
	}),
	responseComponent: "DispatchAnalytics",
});

export const analyticsRouteContracts: readonly RouteContract[] = [
	opsOverview,
	costAnalytics,
	runAnalytics,
	behavior,
	dispatchAnalytics,
];
