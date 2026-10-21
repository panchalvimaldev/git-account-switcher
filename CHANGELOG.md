# Changelog

All notable changes to Git Account Switcher are documented here.

## 0.1.1

- Added HTTPS account selection through Git Credential Manager without changing remote URLs.
- Added automatic migration prompts for existing SSH-only accounts.
- Added branch-aware remote selection for repositories with mixed SSH and HTTPS remotes.
- Added rollback-safe repository configuration updates.
- Redacted credentials and private-key paths from extension logs.
- Improved nested repository, worktree, multi-root, and Bitbucket handling.
- Added unit tests and cross-platform continuous integration.

## 0.1.0

- Initial SSH-based account switching, cloning, push, pull, status bar, and connection testing.
