# Shasderias fork maintenance

This checkout is a maintained fork of `getpaseo/paseo`. Read this file before
performing an upstream update or release.

## Operator intent

The user normally prompts:

> Read AGENTS.shasderias.md, then release 0.2.6

That instruction authorizes `./shasderias.sh release 0.2.6`, including rebasing
`main`, force-with-lease pushing the fork's `main`, creating the release tag, and
publishing archive assets after CI passes.

Prerequisites are Node at the exact version pinned in `.tool-versions`, `npm`,
`git`, and an authenticated `gh` session for the same host used by `origin`.
GitHub Actions must be enabled on the fork.

Do not read project plan files for this work. Do not use Paseo orchestration
skills: we are building Paseo, not operating it.

## Source and branch model

- `origin` is `shasderias/paseo`
- `upstream` is `getpaseo/paseo`
- `main` is an exact stable upstream release tag plus a small linear stack of
  customization commits
- Never merge upstream into `main`; rebase the customization stack
- Release builds always come from a tag on `main`
- Fork release tags are immutable

The first fork release for upstream `v0.2.6` is:

```text
v0.2.6-shasderias
```

If source changes are required after publishing that tag, use:

```text
v0.2.6-shasderias.2
v0.2.6-shasderias.3
```

A transient workflow failure does not require a new tag; rerun or rebuild the
existing tag.

## Normal commands

```bash
./shasderias.sh status
./shasderias.sh rebase 0.2.6
./shasderias.sh verify 0.2.6
./shasderias.sh release 0.2.6
./shasderias.sh rebuild 0.2.6
./shasderias.sh release 0.2.6 --revision 2
```

Prefer the omnibus script over manually reproducing its operations. It provides
safety branches, clean-tree checks, workflow allowlisting, pinned toolchain
checks, force-with-lease pushes, CI waiting, tag validation, and release asset
validation. After a successful release, old `backup/shasderias-*` branches may
be deleted once the new release has been installed and verified.

## Agent release procedure

When asked to release a version:

1. Run `./shasderias.sh status`
2. Run `./shasderias.sh release <version>`
3. Resolve straightforward rebase conflicts while preserving both upstream
   behavior and the customization commit's intent
4. After completing a stopped rebase, rerun the same release command; it is
   designed to resume safely before the release tag is created
5. If the release tag already exists, never rerun plain `release`: use `rebuild`
   for unchanged source or `release <version> --revision N` after source changes
6. Report the final tag and uploaded archives

Intervene manually only when the script stops. Do not bypass a failed gate.

Stop and ask the user when:

- a rebase conflict makes customization intent ambiguous
- upstream substantially restructures release packaging or desktop updates
- the expected upstream tag is missing or is not on upstream `main`
- the customization commit stack is missing, duplicated, or unexpectedly reordered
- CI fails for a non-obvious reason
- an existing release tag points to a different commit
- force-with-lease reports that the fork changed unexpectedly

## Maintained commits

Keep these as separate, ordered commits directly above the upstream release:

1. `chore(fork): disable upstream release automation`
2. `feat(desktop): mark shasderias builds as customized`
3. `ci(fork): automate shasderias archive releases`
4. Functional customization commits, currently including:
   `fix(server): append standard ports (80, 443) to connection hint`

New functional changes remain separate commits. Workflow files newly introduced
by upstream are folded into the first commit by `shasderias.sh rebase`.

## Active automation policy

Only these GitHub Actions workflows may remain active:

```text
.github/workflows/ci.yml
.github/workflows/shasderias-release.yml
```

All other upstream GitHub workflow files are retained with a `.disabled` suffix.
All EAS workflow files are disabled the same way. This is essential because fork
release tags still begin with `v` and would otherwise trigger upstream desktop,
mobile, deployment, Docker, Nix, and release-note automation.

## Release artifacts

The fork publishes only:

- Linux x64 `.tar.gz`
- Windows x64 `.zip`
- Windows arm64 `.zip`
- `SHA256SUMS`

Do not add macOS, DMG, AppImage, DEB, RPM, NSIS/EXE, Flatpak, Android, iOS, EAS,
Docker, website, relay, or updater-manifest release jobs.

The desktop build still exports the Expo web renderer because it is part of the
Electron desktop application. It must not invoke native mobile builds.

## Customized-build invariant

Packaged fork builds are stamped with `paseoCustomized: true` and owner
`shasderias`. They display that status and refuse upstream application updates.
Keep all workspace semantic versions equal to the upstream version; do not add a
fork suffix to only the desktop package because the desktop and bundled daemon
compare their versions.
