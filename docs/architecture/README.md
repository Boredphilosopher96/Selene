# Selene architecture

Selene is a **local-first, headless design core**. It is deliberately useful
without a server, a bundled agent, or a graphical client. The core owns a
React-source project model and deterministic simulation; adapters may render
that model in a browser, a desktop shell, a CLI, or a future editor.

Architecture decisions are versioned ADRs so integrations can rely on stable
contracts rather than implementation details:

- [ADR-0001: Local-first headless core](ADR-0001-local-first-headless-core.md)
- [ADR-0002: React-source project model and simulation](ADR-0002-react-source-model.md)
- [ADR-0003: Portable agent protocol](ADR-0003-portable-agent-protocol.md)
- [ADR-0004: Federated design inputs and handoff](ADR-0004-federated-design-inputs.md)
- [ADR-0005: Trust boundaries](ADR-0005-trust-boundaries.md)

Machine-readable protocol definitions live in [`schemas/`](../../schemas/).
They are standalone JSON Schema documents, not a runtime dependency or an API
server contract.
