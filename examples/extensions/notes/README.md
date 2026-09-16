# Notes extension fixture

A separate extension package used alongside Agent Context to demonstrate independent qualified contribution IDs and host-provided namespaced UI storage. It contributes a local Notes textarea and an explicit Vertical stack recipe; it has no document schema or skills.

The generated bundle is self-contained. The source imports only `wolfpack-bridge/extensions`; no Wolfpack app state, server, broker, filesystem, authentication, or terminal APIs are available to the package.
