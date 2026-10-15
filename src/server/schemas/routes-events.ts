/**
 * Batch 4 — the four event routes.
 *
 * `GET /events` is a JSON page. The other three are NDJSON. OpenAPI has
 * no shape for an unbounded live tail, so each stream's success schema
 * is one line. A closed tail (`follow=0`, or `limit`) may be an empty
 * body. The connection stays open while follow is on.
 */

import * as z from "zod";
import { LIFECYCLE_HOOKS } from "../../runs/lifecycle-bus.ts";
import { eventStreamSchema, runStateSchema } from "./components.ts";
import { defineRoute, type RouteContract } from "./registry.ts";

const lineDescription =
	"One NDJSON line. A closed tail may be empty. A live tail stays open and writes more lines.";

const runEvent = z.strictObject({
	id: z.number().int(),
	runId: z.string(),
	seq: z.number().int(),
	ts: z.string(),
	kind: z.string(),
	stream: eventStreamSchema.nullable(),
	origin: z.string().nullable(),
	payload: z.unknown().describe("The shape depends on `kind`."),
});

const runEvents = defineRoute("GET", "/runs/:id/events", {
	response: runEvent,
	responseComponent: "RunEvent",
	responseDescription: lineDescription,
	contentType: "application/x-ndjson",
});

const listEvents = defineRoute("GET", "/events", {
	response: z.strictObject({
		events: z.array(runEvents.response),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	}),
	responseComponent: "EventList",
	responseDescription: "A page of events. The public projection omits internal rows.",
});

const lifecycleLine = defineRoute("GET", "/events/stream", {
	response: z.strictObject({
		runId: z.string(),
		hook: z.enum(LIFECYCLE_HOOKS),
		state: runStateSchema.nullable(),
		ts: z.string(),
	}),
	responseComponent: "LifecycleNotification",
	responseDescription: lineDescription,
	contentType: "application/x-ndjson",
});

const planRunEvents = defineRoute("GET", "/plan-runs/:id/events", {
	response: runEvents.response,
	responseComponent: "RunEvent",
	responseDescription: lineDescription,
	reuseResponse: true,
	contentType: "application/x-ndjson",
});

export const eventRouteContracts: readonly RouteContract[] = [
	listEvents,
	lifecycleLine,
	runEvents,
	planRunEvents,
];
