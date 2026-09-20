# Changesets

This directory contains changesets — see [the Changesets documentation](https://github.com/changesets/changesets)
for details.

Add one to any PR that should trigger a release:

```bash
pnpm changeset
```

It asks whether the change is a patch/minor/major bump and for a short description, then writes a
markdown file here. Merging the PR triggers `.github/workflows/release.yml`, which either opens (or
updates) a "Version Packages" PR, or — once that PR is merged — bumps the version, updates
`CHANGELOG.md` and publishes to npm automatically.
