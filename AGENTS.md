# Repository guidance

Register is a pi extension loaded directly from TypeScript. Read [arch.md](arch.md)
for its state, storage and compaction contracts. Preserve the exact model-facing
guidance in §2.4 and its equality test in `test/integration.test.ts`.

## Changes and checks

- Run `npm run validate`: lint without warnings, strict types, deterministic tests
  and package inspection. Use `npm run format` for the shared style.
- Add tests with behavioral changes, including lifecycle and package boundaries.
  Distinguish extension correctness from a model's decisions about note-taking.
- Keep documentation aligned with implemented behavior. Do not add agent scratch
  notes, work logs or duplicate management documents to the repository.
- Keep the approved artwork filenames stable. Edit the generators and regenerate
  the existing assets rather than adding numbered alternatives.

## Integration and isolation

- Use public pi APIs. Do not patch pi core, mutate private runtime fields or import
  internal `dist/core` modules. Keep the entry point loadable without bundling.
- Host-provided pi packages and `typebox` remain optional `"*"` peers, never runtime
  dependencies. Pin development dependencies and commit the lockfile.
- Integration tests use disposable workspaces and isolated agent/session directories.
  Disable unrelated extensions and context discovery; never read or change personal
  settings, credentials, sessions or working data. Real-provider tests need explicit
  authorization and separate state; never log credentials.

## Commits and releases

- Make dependency-coherent commits: one logical change with its tests and docs.
  Use Conventional Commit subjects such as `feat:`, `fix:`, `docs:` and `chore:`;
  explain substantial motivations in the body. Do not commit failing intermediate
  scaffolding just to make smaller commits.
- Keep runtime sources, documentation assets, the package `files` allowlist and
  packaging tests aligned. Tests and generators belong in the GitHub source tree,
  not the installable package. Databases, credentials and private session data
  belong in neither.
- GitHub releases and npm publication are separate. Keep `private: true` unless npm
  publication is explicitly authorized. Before a release, validate a clean checkout,
  wait for CI, synchronize package/lockfile/changelog versions, and tag the verified
  commit. Do not move published tags or force-push release history.
- Push, tagging and publication require an explicit request.
