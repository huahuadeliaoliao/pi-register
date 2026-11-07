# Changelog

## [Unreleased]

### Added

- A model-managed session workspace for plans, debugging notes, discussion takeaways
  and drafts—without scattering working documents across the project.
- Automatic full-body context presentation and unchanged carry-forward through
  conversation compaction.
- A fixed 30,000-token capacity with atomic over-limit rejection, exact edits and
  stale-write protection.
- Immutable revision history, non-destructive restoration and branch-aware recovery
  across resume, reload, tree navigation and forks.
- The `/register` read-only viewer and the `register_write`, `register_history` and
  `register_restore` model tools.
- Stable unchanged context and prefix-preserving first writes from fresh empty
  initialization; later updates and compaction can still affect cache reuse.
- SQLite-backed persistence, current-body recovery from a consistent session copy,
  in-memory `--no-session` operation and explicit compaction-producer cooperation.
- Isolated regression and installed-package tests, Node.js CI, and reproducible
  brand and architecture artwork.

### Compatibility

- Requires Node.js 22.19.0+; the pinned development and integration baseline is pi
  1.4.0. Other pi versions and uncoordinated compaction extensions are not covered
  by the optional peer ranges.
- Distributed through GitHub, not npm. Register content is part of model context;
  clearing it is not history erasure, and its capacity does not enlarge the model window.
