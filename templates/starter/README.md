# Cloud Connector – Starter Template

This template contains everything you need for integrating the Serviceware Cloud
with the Cloud Connector and the new function-based approach.

## Quick Start

### 1. Prerequisites

- Docker and Docker Compose
- WebSocket URL from Serviceware (you will receive this from your Serviceware
  contact)

### 2. Configuration

```bash
# Create .env file
cp .env.example .env

# Edit .env file
nano .env  # or your preferred editor
```

Outbound workload requests are denied until you add anchored URL regular
expressions to `OUTBOUND_URL_ALLOWLIST`. Keep `[]` when the functions do not
need network access; use `[".*"]` only for an intentional unrestricted setup.

### 3. Customize Functions

Create your API endpoints in the `functions/` directory. The file structure
directly corresponds to URL paths:

| File                           | URL Path     |
| ------------------------------ | ------------ |
| `functions/health.ts`          | `/health`    |
| `functions/users/index.ts`     | `/users`     |
| `functions/users/[id].ts`      | `/users/:id` |
| `functions/proxy/[...path].ts` | `/proxy/*`   |

### 4. Start

```bash
docker-compose up -d
```

### 5. Test

```bash
# Health check
curl http://localhost:8080/health

# Get users
curl http://localhost:8080/users

# Filter users by department
curl http://localhost:8080/users?department=IT

# Get single user
curl http://localhost:8080/users/1

# Create new user
curl -X POST http://localhost:8080/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Test User", "email": "test@example.com"}'

# View logs
docker-compose logs -f
```

## Project Structure

```
my-cloud-connector/
├── deno.json              # Project configuration (for local development)
├── docker-compose.yml     # Docker deployment
├── .env.example           # Example configuration
├── .env                   # Your configuration (do not commit!)
└── functions/             # Your API functions
    ├── health.ts          # GET /health
    ├── users/
    │   ├── index.ts       # GET/POST /users
    │   └── [id].ts        # GET/PUT/DELETE /users/:id
    └── proxy/
        └── [...path].ts   # All methods: /proxy/*
```

## Function Development

### Basic Structure

Each function file exports an HTTP route definition. Use `defineHttp` for a
compact functional style or `http()` for a fluent style:

```typescript
import { defineHttp } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
  get: (ctx) => {
    return ctx.res.ok().json({ message: "Hello World" });
  },

  post: async (ctx) => {
    const body = await ctx.req.body.json<{ name: string }>();
    return ctx.res.created().json({ created: body.name });
  },
});
```

### Handler Context

In each handler you have access to:

```typescript
ctx.requestId; // UUID of the current request
ctx.startedAt; // ISO 8601 timestamp
ctx.req.method; // HTTP method (GET, POST, etc.)
ctx.req.url; // URL object with pathname, search, etc.
ctx.req.params.get("id"); // URL parameters
ctx.req.query.get("department"); // URLSearchParams for query parameters
ctx.req.headers; // Request headers
ctx.env; // Environment variables (e.g., ctx.env.API_TOKEN)
ctx.req.raw; // Original Request object
ctx.res; // Response factory
ctx.proxy; // HTTP proxy builder
```

### Reading Body

```typescript
// As JSON (generically typed)
const data = await ctx.req.body.json<MyType>();

// As text
const text = await ctx.req.body.text();

// As FormData
const form = await ctx.req.body.formData();

// As ArrayBuffer
const buffer = await ctx.req.body.arrayBuffer();
```

### Creating Responses

```typescript
// JSON response
return ctx.res.ok().json({ data: "value" });

// JSON with status
return ctx.res.created().json({ created: true });

// Text response
return ctx.res.ok().text("Hello World");

// 204 No Content
return ctx.res.noContent();

// Error response
return ctx.res.badRequest("Invalid request");
return ctx.res.notFound("Not found");
return ctx.res.internalServerError("Internal error");
```

### URL Parameters

With `[param].ts` files you can define dynamic segments:

```typescript
// functions/users/[id].ts
// Matches: /users/123, /users/abc, etc.

export default defineHttp({
  get: (ctx) => {
    const id = ctx.req.params.require("id"); // "123" or "abc"
    return ctx.res.ok().json({ userId: id });
  },
});
```

### Catch-All Parameters

With `[...param].ts` files you can capture multiple segments:

```typescript
// functions/files/[...path].ts
// Matches: /files/a, /files/a/b, /files/a/b/c, etc.

export default defineHttp({
  get: (ctx) => {
    const path = ctx.req.params.require("path"); // "a/b/c"
    return ctx.res.ok().json({ filePath: path });
  },
});
```

## Local Development

With Deno you can test your functions locally:

```bash
# Type check
deno task check

# Run tests
deno task test
```

## Environment Variables

All environment variables are available in the handler via `ctx.env`:

```typescript
export default defineHttp({
  get: (ctx) => {
    const apiToken = ctx.env.API_TOKEN;
    // ...
  },
});
```

### Example: Call Backend With Auth Header

```typescript
import { defineHttp } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
  get: async (ctx) => {
    const response = await fetch(`${ctx.env.API_URL}/users`, {
      headers: {
        authorization: `Bearer ${ctx.env.API_TOKEN}`,
        "x-request-id": ctx.requestId,
      },
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
});
```

### Example: Reject Request

```typescript
import { http } from "@serviceware/cloud-connector-sdk";

export default http()
  .get((ctx) => {
    if (ctx.req.path.includes("/admin")) {
      return ctx.res.forbidden("Admin access not allowed");
    }

    return ctx.res.ok().json({ ok: true });
  });
```

## Local Development (optional)

For type checking without Docker:

```bash
# Install Deno (if not present)
# https://deno.land/manual/getting_started/installation

# Type check
deno task check
```

## Support

For questions, contact your Serviceware representative.
