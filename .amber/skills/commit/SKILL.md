---
name: commit
description: Commit the current changes in this git repository with a generated commit message; pass "push" to also push to the remote.
argument-hint: [push]
allowed-tools: Bash, Read, Glob, Grep
---

Commit the current changes in this git repository.

1. Review the working tree (`git status`, `git diff`, `git diff --cached`) and the recent commit style (`git log`), then stage and commit the changes.
2. Create a concise, to-the-point commit title, favor bullet points in the body section, and make sure the body covers the high-level details of the change.
3. If the ARGUMENTS include `push`, push the commit to the remote after creating it. Otherwise, do not push the commit.
