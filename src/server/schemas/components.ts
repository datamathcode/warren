/**
 * Document schemas shared by the HTTP routes. Enum values come from
 * `src/core/wire.ts` so the spec cannot drift from the wire vocabulary.
 *
 * Fields a public spectator never receives are optional. The operator
 * body still sends them, and both shapes have to parse: response tests
 * run against the operator, and the public projection drops keys rather
 * than nulling them.
 */

import * as z from "zod";
import {
	AGENT_SOURCES,
	CLONE_KINDS,
	EVENT_STREAMS,
	INBOX_PRIORITIES,
	INBOX_STATES,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_SOURCES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	PULL_REQUEST_LIFECYCLES,
	RUN_COST_BASES,
	RUN_FAILURE_REASONS,
	RUN_MODES,
	RUN_STATES,
} from "../../core/wire.ts";
import { publish } from "./registry.ts";

const nullString = z.string().nullable();
const nullInt = z.number().int().nullable();
/** Present for the operator, omitted on the public projection. */
const maybeString = nullString.optional();

export const runStateSchema = publish("RunState", z.enum(RUN_STATES));
export const runFailureReasonSchema = publish("RunFailureReason", z.enum(RUN_FAILURE_REASONS));
export const runModeSchema = publish("RunMode", z.enum(RUN_MODES));
export const runCostBasisSchema = publish("RunCostBasis", z.enum(RUN_COST_BASES));
export const cloneKindSchema = publish("CloneKind", z.enum(CLONE_KINDS));
export const previewStateSchema = publish("PreviewState", z.enum(PREVIEW_STATES));
export const eventStreamSchema = publish("EventStream", z.enum(EVENT_STREAMS));
export const planRunStateSchema = publish("PlanRunState", z.enum(PLAN_RUN_STATES));
export const planRunChildStateSchema = publish("PlanRunChildState", z.enum(PLAN_RUN_CHILD_STATES));
export const planRunSourceSchema = publish("PlanRunSource", z.enum(PLAN_RUN_SOURCES));
export const agentSourceSchema = publish("AgentSource", z.enum(AGENT_SOURCES));
export const pullRequestLifecycleSchema = publish(
	"PullRequestLifecycle",
	z.enum(PULL_REQUEST_LIFECYCLES),
);

/** Empty object. A route with `body: "none"` publishes this as its request body. */
export const noRequestBodySchema = publish(
	"NoRequestBody",
	z.strictObject({}),
	"This operation takes no JSON body. An empty body or an empty object is valid.",
);

export const errorEnvelopeSchema = publish(
	"ErrorEnvelope",
	z.strictObject({
		error: z.strictObject({
			code: z.string(),
			message: z.string(),
			hint: z.string().optional(),
		}),
	}),
	"Error body for every non-success response.",
);

export const projectSchema = publish(
	"Project",
	z.strictObject({
		id: z.string(),
		gitUrl: z.string(),
		localPath: maybeString,
		defaultBranch: z.string(),
		addedAt: z.string(),
		lastFetchedAt: nullString,
		lastHeadSha: nullString,
		hasSeeds: z.boolean(),
	}),
	"A registered project. `localPath` is omitted for a public spectator.",
);

export const agentSchema = publish(
	"Agent",
	z.strictObject({
		id: z.number().int(),
		name: z.string(),
		renderedJson: z.unknown().optional(),
		registeredAt: z.string(),
		lastRefreshed: z.string(),
		description: nullString,
		provider: nullString,
		model: nullString,
		source: agentSourceSchema,
	}),
	"An agent row. `renderedJson` is omitted for a public spectator.",
);

export const runSchema = publish(
	"Run",
	z.strictObject({
		id: z.string(),
		agentName: z.string(),
		projectId: nullString,
		sandboxId: maybeString,
		sandboxRunId: maybeString,
		workerId: maybeString,
		seedId: nullString,
		parentRunId: nullString,
		cloneKind: cloneKindSchema.nullable(),
		retryOf: nullString,
		mode: runModeSchema,
		renderedAgentJson: z.unknown().optional(),
		state: runStateSchema,
		failureReason: runFailureReasonSchema.nullable(),
		createdAt: nullInt,
		startedAt: nullString,
		endedAt: nullString,
		workspaceReadyAt: nullString,
		agentReadyAt: nullString,
		agentEndedAt: nullString,
		reapedAt: nullString,
		commitsAhead: nullInt,
		filesChanged: nullInt,
		insertions: nullInt,
		deletions: nullInt,
		prompt: z.string(),
		trigger: z.string(),
		prUrl: nullString,
		prState: pullRequestLifecycleSchema.nullable(),
		prMergedAt: nullString,
		targetBranch: nullString,
		branch: nullString,
		ref: nullString,
		baseCommit: nullString,
		baseSha: nullString,
		provider: nullString,
		model: nullString,
		salvageRef: nullString,
		salvagePath: maybeString,
		costUsd: z.number().nullable(),
		tokensInput: nullInt,
		tokensOutput: nullInt,
		tokensCacheRead: nullInt,
		tokensCacheWrite: nullInt,
		previewState: previewStateSchema.nullable(),
		previewPort: nullInt,
		previewStartedAt: nullString,
		previewLastHitAt: nullString,
		previewFailureMessage: maybeString,
		costBasis: runCostBasisSchema,
		maxCostUsd: z.number().nullable().optional(),
		runtimeBackend: z.string().nullable().optional(),
	}),
	"A run row. Operator-only fields are optional because the public projection omits them.",
);

export const planRunSchema = publish(
	"PlanRun",
	z.strictObject({
		id: z.string(),
		planId: nullString,
		source: planRunSourceSchema,
		projectId: z.string(),
		agentName: z.string(),
		promptTemplate: maybeString,
		ref: nullString,
		providerOverride: maybeString,
		modelOverride: maybeString,
		maxCostUsd: z.number().nullable().optional(),
		dispatcherHandle: maybeString,
		trigger: z.string(),
		parentRunId: nullString,
		state: planRunStateSchema,
		failureReason: maybeString,
		createdAt: z.string(),
		startedAt: nullString,
		endedAt: nullString,
		resumedAt: nullString,
	}),
	"A plan-run row. Dispatch overrides and the prompt template are omitted for a public spectator.",
);

export const planRunChildSchema = publish(
	"PlanRunChild",
	z.strictObject({
		planRunId: z.string(),
		seq: z.number().int(),
		seedId: z.string(),
		runId: nullString,
		state: planRunChildStateSchema,
		createdAt: z.string(),
		updatedAt: z.string(),
		startedAt: nullString,
		endedAt: nullString,
		prMergedAt: nullString,
		failureReason: maybeString,
		retryCount: z.number().int(),
	}),
	"One child of a plan-run. `failureReason` is omitted for a public spectator.",
);

export const sandboxSchema = z.strictObject({
	id: z.string(),
	workspacePath: z.string(),
});

export const inboxMessageSchema = publish(
	"InboxMessage",
	z.strictObject({
		id: z.string(),
		runId: z.string().nullable(),
		body: z.string(),
		priority: z.enum(INBOX_PRIORITIES),
		fromActor: z.string(),
		state: z.enum(INBOX_STATES),
		createdAt: z.string(),
		deliveredAt: z.string().nullable(),
	}),
	"A steering message on a run.",
);
