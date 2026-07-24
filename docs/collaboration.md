# Collaboration service

Selene’s collaboration package is optional. The desktop and static web apps
continue to use local persistence with no account, database, or network
dependency. `@selene/collaboration` adds a port-driven service only for teams
that choose shared review.

## Domain and authorization

Projects belong to organizations; users and memberships reserve fields for OIDC
or SAML subjects and RBAC roles (`owner`, `admin`, `editor`, `commenter`,
`viewer`, and `guest`). The PostgreSQL adapter resolves every authenticated
action through an active organization membership: owners/admins can delete,
owners/admins/editors can create and change designs or manage sharing,
commenters can comment, and viewers/guest members are read-only. Approval is
limited to owners, admins, and editors.
Signed guest capabilities remain scoped to one project and either viewer or
commenter permission.
The bundled proxy adapter accepts `x-selene-user-id` only when the request also
contains a server-only `x-selene-proxy-secret` matching
`COLLABORATION_PROXY_SECRET`. Strip both headers at the public edge, inject
them only after OIDC/SAML/session verification, and rotate the shared secret
through your secret manager. The injected user ID must be Selene's internal
user UUID after provisioning/mapping the external subject; browser-provided
identity and role headers are discarded.

Each save is an immutable revision. Threads reference a revision, a stable
`data-selene-node-id`/React node ID, and a named scenario. Comments can reply
to one another, mention users, carry reactions, resolve a thread, and record
per-user approval decisions. Every write should append an audit event.

## Storage, concurrency, and operations

The ordered migrations provide PostgreSQL tables, foreign keys,
checks, partial indexes, idempotency keys, and the project/revision unique
constraint. Run all four ordered migrations. The generated-design baseline
command locks the project row, then writes the revision, readiness projection,
semantic change, and idempotency response in one transaction.
Clients retry mutating requests with an `Idempotency-Key` header. The service
returns the originally stored response for a retry, including its generated ID.

Every successful mutation emits a durable event with an opaque, increasing
cursor. Reconnect with `GET /v1/projects/:id/events?after=<cursor>` (the
response supplies `nextCursor`), or use
`GET /v1/projects/:id/events/stream` for server-sent events and reconnect using
the SSE `Last-Event-ID`. The durable endpoint is the recovery path for dropped
streams and deployments; clients must not infer ordering from timestamps.

The Fetch-compatible service exposes health (`/healthz`), Prometheus text
metrics (`/metrics`), JSON validation, CORS allow-listing, and a small
per-client rate limiter. Put production rate limits, logs, authentication, and
authorization at the edge as well.

## Generated-design API and compatibility

`@selene/collaboration` exposes one repository command with three explicit,
discriminated transactions: `append-revision`, `mark-ready`, and
`append-revision-and-mark-ready`. This avoids optional-field combinations such
as a readiness transition with a semantic change. Both the in-memory adapter
and PostgreSQL adapter implement this command; callers can substitute either
without changing the domain contract.

`DesignReviewState` is the independently versioned
`selene-design-review-state/v1` portable read model. A project without a
baseline reports the draft/none state; a current baseline has no exact changes;
a stale baseline has exact changes and stale approvals. The parser accepts
`unknown` and validates nested baseline identity, readiness/intent agreement,
revision references, scope, evidence, provenance, timestamps, and exact
change ownership before exposing the read model. Collaboration snapshots remain
`selene-collaboration/v1`; `designReviewState` is optional only for imports
created before baseline persistence. New snapshots validate the field strictly
and reject inconsistent data rather than exposing it to callers.

## Self-hosting

The runnable Bun service is `apps/collaboration-service`. It defaults to
PostgreSQL; set `COLLABORATION_STORE=memory` only for a standalone local demo.
Its header identity provider is deliberately replaceable—production hosts must
inject a verified OIDC/SAML/session identity before the service routes.

```sh
export DATABASE_URL=postgres://selene:selene@localhost:5432/selene
export COLLABORATION_SHARE_SECRET='replace-with-at-least-32-random-characters'
export COLLABORATION_PROXY_SECRET='replace-with-another-32-character-secret'
export CORS_ORIGINS=https://review.example.test
bun run --cwd apps/collaboration-service migrate
bun run --cwd apps/collaboration-service start
```

For a container build from the repository root:

```sh
docker build -f apps/collaboration-service/Dockerfile -t selene-collaboration .
docker run --rm -p 8787:8787 --env DATABASE_URL --env COLLABORATION_SHARE_SECRET --env CORS_ORIGINS selene-collaboration
```

`/healthz` reports process health, while `/readyz` checks the configured
repository connection. The integration harness exercises the production HTTP
wrapping and the deterministic in-memory persistence adapter; use the migration
file plus the commands above against a real Postgres instance for deployment.

## Sharing, portability, and privacy

Guest links are signed, time-limited grants with either viewer or commenter
permission. The Bun host HMAC-signs and hashes each bearer token, stores only
the hash in `share_links`, and verifies its persisted, non-revoked record before
granting access. Revoke a link with `DELETE /v1/share-links/:id`; never log or
persist the returned raw token. Inject a production HMAC/Ed25519 signer through
`ShareTokenSigner` when replacing the host adapter.

`GET /v1/projects/:id/export` returns a portable collaboration snapshot;
`POST /v1/import` restores one. Backups should run that export for every
project, encrypt the resulting artifacts, test restore into an isolated
database, and retain only the window required by policy. Deletion uses the
repository’s `deleteProject` operation; production deployments should implement
an auditable soft-delete/retention job before physical erasure and remove any
object-store backups when the retention window ends.
