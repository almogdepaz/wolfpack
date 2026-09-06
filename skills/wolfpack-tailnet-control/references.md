# wolfpack control references

load only the canonical document needed for the task:

- [session-control.md](https://github.com/almogdepaz/wolfpack/blob/main/docs/session-control.md)
- [README.md](https://github.com/almogdepaz/wolfpack/blob/main/README.md)
- [troubleshooting.md](https://github.com/almogdepaz/wolfpack/blob/main/docs/troubleshooting.md)
- [broker-protocol.md](https://github.com/almogdepaz/wolfpack/blob/main/docs/broker-protocol.md)

when working in the wolfpack source checkout, use the corresponding checked-out document for that revision. `/Users/home/Dev/wolfpack/skills/wolfpack-tailnet-control/` is the single upstream authoring source for distributed control behavior. `~/dotfiles/skills/wolfpack-tailnet-control/` is a downstream installation/overlay for local policy routing, not a coequal source. Keep local-only policy in dotfiles instructions/adaptations rather than forking distributed behavior.

A manual downstream sync must record a receipt with the upstream `git rev-parse HEAD`, whether that upstream path was dirty, and the sha256 digest of the actual synchronized source body. An uncommitted upstream body is identified by its digest plus dirty status, never claimed as a published revision. Reconcile deliberate local changes into upstream before synchronization; never blindly overwrite a dirty copy. setup does not automatically replace an existing installed skill.
