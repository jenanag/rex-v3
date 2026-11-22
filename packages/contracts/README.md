# @rex/contracts

Contract **data**, no code: the single source of truth for every contract. It is not an
npm dependency of anything: each service gets generated copies of what it needs
(**vendoring**, [ADR 0018](../../docs/adr/0018-tool-portability.md)), and code that uses
them is generated in the service (see [ADR 0006](../../docs/adr/0006-contract-first-openapi.md)
and [ADR 0012](../../docs/adr/0012-bus-contracts.md)).

| File | What it defines | Consumed by |
|---|---|---|
| [openapi/common.yaml](openapi/common.yaml) | Shared OpenAPI components: errors, pagination, params, headers, security schemes (user tokens, API keys, service tokens; platform specs only, tools declare none), ID schemas (the prefix registry), primitives, shared enums, shapes used by several specs (`TrackedBrand`, `LlmUsage`, `LlmsTxtValidation`, ...), job fields, health probes | every `openapi/services/*.yaml` and events.yaml via `$ref` |
| [openapi/services/](openapi/services/) | One REST contract per service (`<service>.yaml`): gateway, orchestrator and the six Phase 2 tools | Redocly lint; vendored (bundled) into the service and its callers |
| [asyncapi/events.yaml](asyncapi/events.yaml) | Every bus message: routing key, version, producers, envelope and payload (payloads `$ref` tool schemas) | vendored into orchestrator and workers (types generated there), [docs/events.md](../../docs/events.md) |
| [bus/topology.yaml](bus/topology.yaml) | RabbitMQ exchanges, queues, bindings (and so the consumers), prefetch, configurable retry policy (placeholder values), dead-lettering, publish properties | vendored; `@rex/bus` (`rex-bus declare` applies it at deploy time), events.yaml channel bindings, [docs/events.md](../../docs/events.md) |
| [cache/policy.yaml](cache/policy.yaml) | Cache-first tool calls: backend, key derivation (the only definition), modes, scopes, override resolution and limits, store rules, single-flight, TTL or window and scope per tool operation, per-tool `keyVersion` | vendored into workers, gateway and orchestrator; applied by `@rex/cache`; generated cache sections of the tool docs |
| [data/ai-crawlers.yaml](data/ai-crawlers.yaml) | Known AI crawlers (validated against `AiCrawler` in common.yaml) | vendored into content-auditor (ai-traffic-analyzer in Phase 7) |
| [vendoring.yaml](vendoring.yaml) | Which file is vendored into which service, how (bundle, copy, generated types in the tool's language) and from which phase; each tool's `language` and the template and type generator per language ([ADR 0024](../../docs/adr/0024-per-tool-language.md)) | `scripts/vendor-contracts` (writes), `scripts/check-contracts` (drift) |

Tool input and output schemas stay in the owning tool's file under `openapi/services/`;
the orchestrator spec and events.yaml `$ref` them there. Changes here must be additive
within v1 (rules in [conventions.md](../../docs/conventions.md#3-versioning)); after a
change, run `scripts/vendor-contracts` and commit the regenerated copies (CI fails on
drift).
