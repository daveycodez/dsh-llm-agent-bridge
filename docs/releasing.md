# Release Contract

`relay-dsh-plugin-claude` is published independently from its own GitHub
repository. Relay monorepo state is never part of the release input.

## Version And Tag

- Commit the intended version in both `package.json` and `package-lock.json`.
- A release tag must be exactly `v<package version>`, for example `v0.1.0`.
- Stable versions publish to npm's `latest` dist-tag.
- Versions containing a SemVer prerelease suffix publish to `next`.
- The tagged commit must be reachable from `main`.

`scripts/release-metadata.mjs` is the executable source of truth for these rules.
Its unit tests must pass before the release workflow can publish.

## Acceptance Gates

The GitHub Actions release job must:

1. install dependencies without running dependency lifecycle scripts;
2. verify against the pinned clean official DSH commit;
3. run type checks, tests, and the production build;
4. reject changes to tracked `lib/` artifacts after rebuilding;
5. inspect the npm tarball; and
6. publish only a version that does not already exist.

Failure of any gate stops publication.

## npm Trust

After the one-time first publication, configure this package's npm Trusted
Publisher with:

- provider: GitHub Actions
- organization or user: `yangbobo2021`
- repository: `relay-dsh-plugin-claude`
- workflow filename: `release.yml`
- allowed action: `npm publish`

The workflow uses npm OIDC and does not store an npm publish token. Once a
trusted release succeeds, configure npm publishing access to require 2FA and
disallow traditional tokens.

## Release

```bash
npm version <new-version>
git push origin main
git push origin v<new-version>
```

Do not move or reuse a published version tag. npm versions are immutable.
