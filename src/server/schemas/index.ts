/**
 * Side-effect import order: document schemas first, then each route batch.
 * Later batches append their modules here.
 */
import "./components.ts";
import "./routes-core.ts";
import "./routes-reads.ts";
import "./routes-reads-analytics.ts";
import "./routes-writes-projects.ts";
import "./routes-writes-runs.ts";

export {
	componentRef,
	definedRouteContracts,
	type JsonSchema,
	openApiComponents,
	type RouteContract,
	routeContract,
} from "./registry.ts";
export { enforceRequestBody, REQUEST_BODY_VALIDATION_MODE } from "./validate-request.ts";
