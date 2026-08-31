/**
 * @serviceware/cloud-connector-sdk
 *
 * SDK for building Cloud Connector functions.
 *
 * @example
 * ```ts
 * import { http } from "@serviceware/cloud-connector-sdk";
 *
 * export default http()
 *   .get(async (ctx) => {
 *     const users = await fetchUsers(ctx.req.query.get("department"));
 *     return ctx.res.ok().json(users);
 *   })
 *
 *   .post(async (ctx) => {
 *     const body = await ctx.req.body.json<CreateUserInput>();
 *     return ctx.res.created().json(await createUser(body));
 *   });
 * ```
 *
 * @module
 */

// ============================================================================
// HTTP functions - Public API
// ============================================================================

export {
    // Standalone response helpers
    badRequest,
    conflict,
    // Functional API
    defineHttp, error,
    forbidden,
    html,
    // Fluent API
    http, internalServerError,
    json,
    noContent,
    notFound,
    proxy,
    redirect,
    status,
    text,
    unauthorized,
    unprocessableEntity,
    upstream
} from "./http.ts";

// Types for user-defined handlers and middleware
export type {
    DefineHttpConfig,
    HttpContext,
    HttpErrorHandler,
    HttpHandler,
    HttpMiddleware
} from "./http.ts";

// ============================================================================
// HTTP functions - Runtime internals (re-exported for runtime package)
// ============================================================================

export {
    createHttpContext,
    HTTP_METHODS,
    HttpResponseFactory,
    isHttpRouteDefinition
} from "./http.ts";
export type {
    CreateHttpContextOptions,
    HttpRouteDefinition
} from "./http.ts";

// ============================================================================
// Types
// ============================================================================

export type { HttpMethod } from "./types.ts";

// ============================================================================
// Errors
// ============================================================================

export { ErrorCodes, RuntimeError } from "./errors.ts";
