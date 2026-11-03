---
status: Disabled
rules:
  - check: push
    deny: non-fast-forward
    fix: Rebase on the remote branch and push again, or push a new branch.
---

# No force push

Rewriting a shared branch breaks the clones of everyone who pulled it.
This policy stops the push before it leaves the machine; the host's branch
protection is the only guarantee on the server.

To enable it, change `Disabled` to `Enabled` in a pull request.
