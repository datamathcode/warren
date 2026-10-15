/**
 * Batch 2 — read-only GET routes, except the event streams (batch 4).
 * None of these routes read a JSON body.
 */

import * as z from "zod";
import { ISSUE_STATUSES, PLAN_STATUSES } from "../../core/wire.ts";
import { agentSchema, inboxMessageSchema } from "./components.ts";
import { defineRoute, type RouteContract } from "./registry.ts";

const htmlPage = z.string().meta({
	description: "An HTML page. The success body is not JSON.",
});

const healthz = defineRoute("GET", "/healthz", {
	response: z.strictObject({ ok: z.literal(true) }),
	responseComponent: "Healthz",
});

const readyzCheck = z.strictObject({
	name: z.string(),
	ok: z.boolean(),
	message: z.string().optional(),
	hint: z.string().optional(),
});

const readyz = defineRoute("GET", "/readyz", {
	response: z.strictObject({ ok: z.boolean(), checks: z.array(readyzCheck) }),
	responseComponent: "Readyz",
	responseDescription:
		"Readiness. A failed check answers 503 with this same body; the document's success status is the ready case.",
});

const version = defineRoute("GET", "/version", {
	response: z.strictObject({ version: z.string() }),
	responseComponent: "Version",
});

const whoami = defineRoute("GET", "/whoami", {
	response: z.strictObject({
		identity: z.enum(["operator", "anonymous", "run"]),
		capabilities: z.array(z.enum(["readPublic", "readOperator", "dispatch", "admin"])),
	}),
	responseComponent: "Whoami",
});

const previewConfig = defineRoute("GET", "/preview/config", {
	response: z.strictObject({
		mode: z.enum(["path", "subdomain"]),
		host: z.string().nullable(),
		port: z.number().int().nullable(),
	}),
	responseComponent: "PreviewConfig",
});

const instanceAdmission = z.strictObject({
	maxQueueDepth: z.number(),
	maxPendingPods: z.number(),
	maxProjectConcurrency: z.number().nullable(),
});

const instance = defineRoute("GET", "/instance", {
	response: z.strictObject({
		version: z.string(),
		runtime: z.enum(["local", "k8s", "docker"]),
		authMode: z.enum(["token", "public"]),
		// Absent on the public spectator projection.
		dbBackend: z.enum(["sqlite", "postgres"]).nullable().optional(),
		uptimeSeconds: z.number().optional(),
		admission: instanceAdmission.nullable().optional(),
	}),
	responseComponent: "InstanceFacts",
});

const forgeRepo = z.strictObject({
	owner: z.string(),
	name: z.string(),
	cloneUrl: z.string(),
	defaultBranch: z.string(),
	private: z.boolean(),
});

const forgeRepos = defineRoute("GET", "/forge/repos", {
	response: z.strictObject({
		supported: z.boolean(),
		repos: z.array(forgeRepo),
		error: z.string().optional(),
	}),
	responseComponent: "ForgeRepos",
});

const agent = defineRoute("GET", "/agents/:name", {
	response: agentSchema,
	responseComponent: "Agent",
	reuseResponse: true,
});

const configFileNotice = z.strictObject({
	file: z.string(),
	code: z.enum([
		"warren_config_parse_error",
		"warren_config_schema_error",
		"warren_config_deprecated",
	]),
	message: z.string(),
});

const warrenDefaults = z
	.looseObject({
		defaultRole: z.string().optional(),
		defaultBranch: z.string().optional(),
		defaultProvider: z.string().optional(),
		defaultModel: z.string().optional(),
		runBranchPrefix: z.string().optional(),
	})
	.nullable();

const warrenConfig = defineRoute("GET", "/projects/:id/warren-config", {
	response: z.strictObject({
		// Triggers and errors are operator-only.
		triggers: z
			.array(
				z.strictObject({
					id: z.string(),
					kind: z.literal("cron"),
					cron: z.string(),
					seed: z.string().optional(),
					role: z.string(),
					timezone: z.string().optional(),
					prompt: z.string().optional(),
					maxCostUsd: z.number().positive().optional(),
				}),
			)
			.nullable()
			.optional(),
		defaults: warrenDefaults,
		sourceFile: z.string().nullable(),
		errors: z.array(configFileNotice).optional(),
		warnings: z.array(configFileNotice),
	}),
	responseComponent: "ProjectWarrenConfig",
});

const triggerSummary = z.strictObject({
	id: z.string(),
	kind: z.literal("cron"),
	cron: z.string(),
	seed: z.string().optional(),
	role: z.string(),
	timezone: z.string().optional(),
	prompt: z.string().optional(),
	maxCostUsd: z.number().optional(),
	lastFiredAt: z.string().nullable(),
	nextFireAt: z.string().nullable(),
	lastRunId: z.string().nullable(),
	parseError: z.string().nullable(),
});

const projectTriggers = defineRoute("GET", "/projects/:id/triggers", {
	response: z.strictObject({
		triggers: z.array(triggerSummary),
		errors: z.array(configFileNotice),
	}),
	responseComponent: "ProjectTriggers",
});

const planSummary = z.strictObject({
	id: z.string(),
	status: z.enum(PLAN_STATUSES),
	seed: z.string().optional(),
	template: z.string().optional(),
	revision: z.number().optional(),
	name: z.string().optional(),
	childCount: z.number().int(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const projectSeedPlans = defineRoute("GET", "/projects/:id/seeds/plans", {
	response: z.strictObject({ plans: z.array(planSummary) }),
	responseComponent: "ProjectSeedPlans",
});

const readyPlan = z.strictObject({
	id: z.string(),
	name: z.string().optional(),
	status: z.string(),
	openChildCount: z.number().int(),
});

const readyPlans = defineRoute("GET", "/projects/:id/ready-plans", {
	response: z.strictObject({ plans: z.array(readyPlan) }),
	responseComponent: "ReadyPlans",
});

const projectSeed = defineRoute("GET", "/projects/:id/seeds/:seedId", {
	response: z.strictObject({
		id: z.string(),
		status: z.enum(ISSUE_STATUSES),
		blockedBy: z.array(z.string()),
	}),
	responseComponent: "ProjectSeed",
});

const runInbox = defineRoute("GET", "/runs/:id/inbox", {
	response: z.strictObject({ messages: z.array(inboxMessageSchema) }),
	responseComponent: "RunInbox",
});

const finalizeIntent = defineRoute("GET", "/runs/:id/finalize-intent", {
	response: z.strictObject({
		intent: z
			.looseObject({
				branch: z.string(),
				push: z.boolean(),
				artifacts: z.array(z.string()),
			})
			.nullable(),
	}),
	responseComponent: "FinalizeIntentPoll",
	responseDescription:
		"The parked finalize intent, or null until reap parks one. Extra intent fields are allowed.",
});

const githubRegister = defineRoute("GET", "/github-app/register", {
	response: htmlPage,
	responseComponent: "HtmlPage",
	contentType: "text/html",
});

const githubCallback = defineRoute("GET", "/github-app/callback", {
	response: htmlPage,
	responseComponent: "HtmlPage",
	reuseResponse: true,
	contentType: "text/html",
});

const githubInstalled = defineRoute("GET", "/github-app/installed", {
	response: htmlPage,
	responseComponent: "HtmlPage",
	reuseResponse: true,
	contentType: "text/html",
});

const setup = defineRoute("GET", "/setup", {
	response: htmlPage,
	responseComponent: "HtmlPage",
	reuseResponse: true,
	contentType: "text/html",
	responseDescription:
		"The one-time setup redemption page. An unarmed boot answers 404 JSON instead.",
});

const metrics = defineRoute("GET", "/metrics", {
	response: z.string(),
	responseComponent: "PrometheusText",
	contentType: "text/plain",
	responseDescription:
		"Prometheus text exposition. The live header also carries version=0.0.4 and charset=utf-8.",
});

const judgeVerdicts = defineRoute("GET", "/extensions/judge/verdicts.jsonl", {
	response: z.string(),
	responseComponent: "NdjsonDocument",
	contentType: "application/x-ndjson",
	responseDescription:
		"The proxied judge export. An unconfigured instance answers 501 JSON instead of this body.",
});

export const readRouteContracts: readonly RouteContract[] = [
	healthz,
	readyz,
	version,
	whoami,
	previewConfig,
	instance,
	forgeRepos,
	agent,
	warrenConfig,
	projectTriggers,
	projectSeedPlans,
	readyPlans,
	projectSeed,
	runInbox,
	finalizeIntent,
	githubRegister,
	githubCallback,
	githubInstalled,
	setup,
	metrics,
	judgeVerdicts,
];
