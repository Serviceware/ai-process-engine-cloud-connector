# Future protocol architecture

The current Cloud Connector wire contract and runtime support HTTP forwarding
only. Future protocol work must preserve the security boundary introduced by the
YAML-only runtime:

- no customer-supplied executable code or module loading;
- no SDK for customer handlers;
- explicit declarative configuration validated before startup;
- default-deny destination policies for every protocol; and
- generated wire models sourced from `openapi/api.yml`.

New protocol families should be modeled as distinct request/response frame
variants in OpenAPI and implemented by dedicated internal executors. They must
not be represented as special HTTP methods, URLs, or header conventions.

Protocol selection belongs to the cloud wire frame, not to customer files. A
connector instance should receive a single validated configuration for each
enabled protocol. Ambiguous fallback modes and targets selected directly by
inbound payloads are prohibited.

Before adding a protocol:

1. extend and regenerate the OpenAPI frame union;
2. define a declarative configuration schema and destination policy;
3. implement the internal executor without dynamic imports or evaluation;
4. add malformed-frame, policy, timeout, credential-redaction, and reconnect
   tests; and
5. document the deployment migration and network requirements.

HTTP remains the only released protocol until its corresponding OpenAPI,
runtime, tests, and operational documentation all ship together.
