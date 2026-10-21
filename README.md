# Git Account Switcher

Pick which Git account to use for **clone, pull and push over SSH or HTTPS** from a popup in VS Code.
It works with the built-in Git extension: it sets the repo's local Git config, and the normal Source Control
buttons (Commit, Push, Pull, Sync) then use that account automatically.

## How it works

For each repo, the extension writes local identity and authentication settings:

| Setting | Effect |
|---|---|
| `user.name` | Name on commits |
| `user.email` | Email on commits |
| `core.sshCommand` | For SSH remotes, selects the account's private key |
| `credential.https://<host>.username` | For HTTPS remotes, tells Git Credential Manager which account to use |

HTTPS remote URLs are not changed. Passwords, OAuth tokens, and personal access tokens are handled by Git Credential Manager and are never stored in this extension's settings.

## Requirements

- Git installed; Git Credential Manager is required for HTTPS authentication
- For SSH, one key per account with the public key added to the matching hosting account

## Quick start

1. Run **Git Accounts: Add Account** from the Command Palette (`Ctrl+Shift+P`) once per account.
   Or edit settings JSON directly:

```json
"gitAccounts.list": [
  {
    "label": "Work",
    "name": "Your Name",
    "email": "work@company.com",
    "sshKey": "C:/Users/you/.ssh/id_ed25519_work",
    "httpsUsername": "work-user"
  },
  {
    "label": "Personal",
    "name": "Your Name",
    "email": "you@gmail.com",
    "httpsUsername": "personal-user"
  }
]
```

2. Run **Git Accounts: Test SSH Connection** to confirm each key authenticates.
3. Open a repo. If it has no local email, a popup asks which account to use.
4. Use VS Code's normal Commit / Push / Pull buttons.

## Commands

| Command | What it does |
|---|---|
| Switch Account for This Repo | Popup to choose the account (also: click the status bar item) |
| Clone with Account | Choose account, paste URL, choose folder, clone, then open |
| Push with Account | Choose account, then push (sets upstream automatically if missing) |
| Pull with Account | Choose account, then pull |
| Add Account | Guided prompts to add an account |
| Test SSH Connection | Checks an SSH key with GitHub/GitLab/Bitbucket; HTTPS is tested during Git operations |
| Open Settings | Opens the extension settings |

The status bar shows the active account for the current repo. It turns yellow when none is set.

## Settings

- `gitAccounts.list`: your accounts; each can contain `sshKey`, `httpsUsername`, or both
- `gitAccounts.promptOnOpen` (default `true`): ask when a repo has no local email
- `gitAccounts.testHost` (default `github.com`): host used by Test SSH Connection

## Limitations

- The built-in Push/Pull buttons cannot show a popup (extensions cannot intercept them). Choose the account
  once per repo; use **Push with Account** / **Pull with Account** if you want to be asked every time.
- The first HTTPS operation may open Git Credential Manager's sign-in flow for the selected username.
- Keys protected by a passphrase need `ssh-agent` running with the key added (`ssh-add <key>`),
  otherwise push/pull fails because VS Code cannot type the passphrase. Keys without a passphrase work directly.
- Use a separate repo-level identity: this extension edits `.git/config` of each repo, not your global config.

## Develop and run

```bash
npm install
npm run compile
```

Open this folder in VS Code and press **F5** to launch an Extension Development Host.

## Build an installable `.vsix`

```bash
npm install
npm run package
```

Then in VS Code: Extensions panel, `...` menu, **Install from VSIX...**, and pick `git-account-switcher-0.1.0.vsix`.
Or from a terminal: `code --install-extension git-account-switcher-0.1.0.vsix`.

## Troubleshooting

- **Permission denied (publickey):** the key is not added to that GitHub account, or the wrong key path is configured.
  Run Test SSH Connection.
- **Still committing with the wrong email:** check the status bar; run `git config --local user.email` in the terminal.
- **Output log:** View, Output, choose **Git Account Switcher** to see every Git command that was run.
