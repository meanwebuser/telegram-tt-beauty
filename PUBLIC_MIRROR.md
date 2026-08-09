# Public mirror policy

This repository is the public, sanitized mirror of the project.

Canonical repositories:

- Private source: `https://github.com/meanwebuser/telegram-tt-beauty-source`
- Public mirror: `https://github.com/meanwebuser/telegram-tt-beauty`

The private source is the only repository where full history, working branches,
deployment material, and local configuration may live. This public repository
is a snapshot; it is not a full Git mirror.

## Hard rules

1. Work and commit in the private source repository.
2. Never add the public repository as a normal working remote.
3. Never push directly to the public `main` branch.
4. Never publish `.env` files, session data, tokens, private keys, internal
   addresses, internal domains, or private deployment instructions.
5. Publish only through `git-private2public` and only after a clean scan.
6. Treat a failed scan as a hard stop. Do not override it with `--force` or by
   copying files manually.

## One-time setup

Install `git-private2public` version `0.2.2` or newer, authenticate GitHub as
`meanwebuser`, and configure GitHub credentials for Git transport:

```bash
gh auth status
gh auth setup-git
```

## Publish flow

Run these commands from any directory. The checked-in config is the only
approved source/target mapping:

```bash
git-private2public scan -c ops/git-private2public-public.yaml
git-private2public publish -c ops/git-private2public-public.yaml
```

The publisher creates a sanitized snapshot on the public mirror's `main`.
After publication, verify the result:

```bash
gh repo view meanwebuser/telegram-tt-beauty --json isPrivate,defaultBranchRef,url
git ls-remote https://github.com/meanwebuser/telegram-tt-beauty.git refs/heads/main
```

The `public-content-guard` workflow must pass. If it fails, do not retry with
different remotes or bypass branch protection; fix the source/configuration,
scan again, and publish only after the scan is clean.

## Updating the source

```bash
git clone https://github.com/meanwebuser/telegram-tt-beauty-source.git
cd telegram-tt-beauty-source
git switch external-transcription
git pull --ff-only
```

The source repository is private. The public mirror must never be used as a
source of truth or merged back into the private source.
