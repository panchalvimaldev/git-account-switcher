# Security Policy

Please do not disclose credential-handling vulnerabilities in a public issue. Report them privately through GitHub's security-advisory feature for this repository.

The extension stores account labels, commit identities, HTTPS usernames, and SSH key paths in VS Code machine settings. It does not store passwords, OAuth tokens, personal access tokens, or private-key contents. HTTPS secrets remain under Git Credential Manager and SSH secrets remain in the selected key files or SSH agent.
