# protocol

The wire contract: provider methods and their schemas, the symbol and fact id grammars, the
conformance suite. Runs without the core, so a provider team is never blocked on us.

## Versioning is a migration window, never a museum

`PROTOCOL_VERSION` majors break the wire. When one does, a newer daemon MAY keep answering the
previous major's read shape so sessions mid-update keep working. That window has rules:

- **One or two versions back. Never more.** The window exists so a running session survives an
  update, not so every past shape lives forever.
- **Delete the old surface when the window closes.** A shape kept "just in case" is the start of
  permanent multi-versioning, where every change costs N implementations and the N-th is always
  the one that drifts.
- **State the removal date in the shim's comment.** A shim with no stated end is permanent.
- **Clients ride forward, never backward.** A client meeting a NEWER protocol daemon connects to
  it (`decideFromLock`); only an older one is replaced. Two sides retiring each other is a war
  that rebuilds the index on every flip.

A major that ships no window is a clean break, which is allowed and sometimes right: say so in
the release notes and tell people to reload.
