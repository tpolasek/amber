---
name: tag
description: Cut the next version tag on the top commit of main and push it to the remote (v1.0.5 -> v1.0.6, v1.0.9 -> v1.1.0).
allowed-tools: Bash
---

Increment the version tag, tag the top commit on main, and push the tag.

1. Verify the current branch with `git rev-parse --abbrev-ref HEAD`. Abort without touching anything if it is not `main`.
2. Compute the next version with the repo script: `./next-tag.sh`. It prints the highest `v*` tag with the patch digit incremented, rolling over into the next section (`v1.0.5` -> `v1.0.6`, `v1.0.9` -> `v1.1.0`, `v1.9.9` -> `2.0.0`), and `v0.0.1` when no tags exist.
3. Abort if the new tag name already exists (`git rev-parse --verify`).
4. Tag the top commit with a lightweight tag (matching the existing repo convention): `git tag <new-tag>`.
5. Push only the tag to the remote: `git push origin <new-tag>`. Do not push any branches.
