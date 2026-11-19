import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ConnectorProcess } from "../integration/connector-process.ts";
import { escapeRegExp, StubTarget } from "../integration/stub-target.ts";
import { AiProcessEngine, e2eEnvironment, type Initiator, type LoggedRequest } from "./ai-process-engine.ts";

const environment = e2eEnvironment();
// Unique per run, so runs against the shared tenant never share a connector.
const purpose = `e2e-${process.env.GITHUB_RUN_ID ?? `local-${randomUUID()}`}`;
const targetToken = `e2e-target-token-${randomUUID()}`;

let target: StubTarget;
let connector: ConnectorProcess;
const engine = new AiProcessEngine(environment, purpose);

beforeAll(async () => {
  target = await StubTarget.start(({ url }) => {
    const status = Number(url.searchParams.get("status") ?? "200");
    return Response.json({ path: url.pathname }, { status });
  });
  connector = await ConnectorProcess.start({
    env: {
      CLOUD_CONNECTOR_HOST: environment.host,
      CLOUD_CONNECTOR_CLIENT_ID: environment.clientId,
      CLOUD_CONNECTOR_CLIENT_SECRET: environment.clientSecret,
      TARGET_API_TOKEN: targetToken,
    },
    config: `
connection:
  purpose: "${purpose}"
  heartbeatIntervalSeconds: 30
logging:
  level: debug
forwarding:
  - target: '^${escapeRegExp(target.url)}/api(?:[/?].*)?$'
    methods: [GET, POST]
    request:
      auth:
        type: bearer
        token: "{{ env.TARGET_API_TOKEN }}"
      headers:
        add:
          x-request-id: "{{ context.requestId }}"
`,
  });
  await connector.waitUntilReady();
  await engine.waitUntilRoutable({ method: "GET", url: `${target.url}/api/routable` });
}, 60_000);

afterAll(async () => {
  if (connector !== undefined) {
    const { output } = await connector.stop();
    console.log(`--- Cloud Connector output (purpose ${purpose}) ---\n${output}`);
    await connector.close();
  }
  await target?.close();
});

test.concurrent("mirrors the status and body of an allowed GET and logs it", async () => {
  const initiator = newInitiator();
  const url = `${target.url}/api/status?status=201`;
  const result = await engine.send({ method: "GET", url, initiator });

  expect(result.status).toStrictEqual(201);
  expect(JSON.parse(result.body)).toStrictEqual({ path: "/api/status" });
  const [logged, ...others] = await engine.loggedRequests(initiator);
  expect(others).toStrictEqual([]);
  expect(logged).toMatchObject({ status: "done", method: "GET", url, initiator, statusCode: 201 });
  expectCompletedTimestamps(logged);
});

test.concurrent("forwards a POST body, replaces caller credentials with the rule's, and logs it", async () => {
  const initiator = newInitiator();
  const url = `${target.url}/api/tickets`;
  const result = await engine.send({
    method: "POST",
    url,
    headers: {
      "content-type": ["application/json"],
      authorization: ["Bearer caller-credential"],
      cookie: ["session=caller"],
    },
    body: '{"title":"Printer broken"}',
    initiator,
  });

  expect(result.status).toStrictEqual(200);
  const forwarded = requestsTo("/api/tickets");
  expect(forwarded.length).toStrictEqual(1);
  expect(forwarded[0].method).toStrictEqual("POST");
  expect(forwarded[0].body).toStrictEqual('{"title":"Printer broken"}');
  expect(forwarded[0].headers.get("content-type")).toStrictEqual("application/json");
  expect(forwarded[0].headers.get("authorization")).toStrictEqual(`Bearer ${targetToken}`);
  expect(forwarded[0].headers.get("cookie")).toStrictEqual(null);

  const [logged, ...others] = await engine.loggedRequests(initiator);
  expect(others).toStrictEqual([]);
  expect(logged).toMatchObject({ status: "done", method: "POST", url, initiator, statusCode: 200 });
  expectCompletedTimestamps(logged);
  expect(forwarded[0].headers.get("x-request-id")).toStrictEqual(logged.id);
});

test.concurrent("denies a target that matches no forwarding rule and logs the connector error", async () => {
  const initiator = newInitiator();
  const url = `${target.url}/admin`;
  const result = await engine.send({ method: "GET", url, initiator });

  expect(result.status).toStrictEqual(502);
  expect(JSON.parse(result.body)).toMatchObject({ code: "OUTBOUND_URL_NOT_ALLOWED" });
  expect(requestsTo("/admin")).toStrictEqual([]);
  const [logged, ...others] = await engine.loggedRequests(initiator);
  expect(others).toStrictEqual([]);
  expect(logged).toMatchObject({
    status: "failed",
    method: "GET",
    url,
    initiator,
    connectorErrorCode: "OUTBOUND_URL_NOT_ALLOWED",
    connectorErrorMessage: expect.stringContaining("not allowed"),
  });
  expect(logged.statusCode).toBeOneOf([null, undefined]);
  expectCompletedTimestamps(logged);
});

test.concurrent("denies a method that the matching rule does not allow and logs the connector error", async () => {
  const initiator = newInitiator();
  const url = `${target.url}/api/tickets/42`;
  const result = await engine.send({ method: "DELETE", url, initiator });

  expect(result.status).toStrictEqual(502);
  expect(JSON.parse(result.body)).toMatchObject({ code: "METHOD_NOT_ALLOWED" });
  expect(requestsTo("/api/tickets/42")).toStrictEqual([]);
  const [logged, ...others] = await engine.loggedRequests(initiator);
  expect(others).toStrictEqual([]);
  expect(logged).toMatchObject({
    status: "failed",
    method: "DELETE",
    url,
    initiator,
    connectorErrorCode: "METHOD_NOT_ALLOWED",
    connectorErrorMessage: expect.stringContaining("DELETE"),
  });
  expect(logged.statusCode).toBeOneOf([null, undefined]);
  expectCompletedTimestamps(logged);
});

test("reports the connector and its session as connected", async () => {
  const connector = await engine.connector();
  expect(connector).toMatchObject({ purpose, status: "connected", activeSessionsCount: 1 });
  expect(connector?.handledRequestsCountLast24h).toBeGreaterThan(0);

  const sessions = await engine.sessions();
  expect(sessions.length).toStrictEqual(1);
  expect(sessions[0]).toMatchObject({ status: "connected" });
  expect(sessions[0].disconnectedAt).toBeOneOf([null, undefined]);
  expect(sessions[0].handledRequestsCount).toBeGreaterThan(0);
});

function newInitiator(): Initiator {
  return { type: "e2e", id: randomUUID() };
}

function expectCompletedTimestamps(logged: LoggedRequest): void {
  const queuedAt = Date.parse(logged.queuedAt);
  const startedAt = Date.parse(logged.startedAt ?? "");
  const finishedAt = Date.parse(logged.finishedAt ?? "");
  expect(queuedAt).toBeLessThanOrEqual(startedAt);
  expect(startedAt).toBeLessThanOrEqual(finishedAt);
}

function requestsTo(pathname: string) {
  return target.requests.filter((request) => request.url.pathname === pathname);
}
