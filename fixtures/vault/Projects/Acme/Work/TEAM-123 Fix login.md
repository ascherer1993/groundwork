---
type: ticket
ticket: TEAM-123
jira: https://example.atlassian.net/browse/TEAM-123
projects: ["[[Acme]]"]
code: [acme-platform:web, acme-platform:auth-lambda]
repo: acme-platform
worktree: TEAM-123-fix-login
branch: TEAM-123-fix-login
status: active
people: ["[[Jane Doe]]"]
---
# TEAM-123 Fix login

## Summary

Login fails when the session cookie expires mid-flow.

## Plan

1. Reproduce
2. Fix refresh logic ^plan-fix

> [!note] Callout
> Check with [[Jane Doe]] before merging.
