import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  formatCommandArgs,
  httpsCredentialContext,
  redactSensitiveText,
  remoteTransport
} from './git-utils';

interface Account {
  label: string;
  name: string;
  email: string;
  sshKey?: string;
  httpsUsername?: string;
}

const out = vscode.window.createOutputChannel('Git Account Switcher');
let statusBar: vscode.StatusBarItem;
const promptedThisSession = new Set<string>();

/* ---------------------------------------------------------------- helpers */

function git(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    out.appendLine(`> git ${formatCommandArgs(args)}${cwd ? `   (cwd: ${cwd})` : ''}`);
    execFile(
      'git',
      args,
      {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (stdout) { out.appendLine(redactSensitiveText(stdout.trim())); }
        if (stderr) { out.appendLine(redactSensitiveText(stderr.trim())); }
        if (err) {
          reject(new Error(redactSensitiveText((stderr || err.message).trim())));
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

function getAccounts(): Account[] {
  // Accounts contain machine-specific key paths and must not be supplied by a
  // repository's workspace settings.
  const configured = vscode.workspace
    .getConfiguration('gitAccounts')
    .inspect<Account[]>('list')?.globalValue ?? [];
  return configured.filter(a =>
    Boolean(a && a.label && a.name && a.email && (a.sshKey || a.httpsUsername))
  );
}

async function ensureHttpsUsername(acc: Account): Promise<string | undefined> {
  const existing = acc.httpsUsername?.trim();
  if (existing) { return existing; }

  const username = await vscode.window.showInputBox({
    prompt: `HTTPS username for "${acc.label || acc.email}"`,
    placeHolder: 'GitHub, GitLab, or Bitbucket username',
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter your hosting-service username'
  });
  if (!username?.trim()) { return undefined; }

  const value = username.trim();
  const cfg = vscode.workspace.getConfiguration('gitAccounts');
  const list = cfg.inspect<Account[]>('list')?.globalValue ?? [];
  const updated = list.map(item =>
    item?.label === acc.label &&
    typeof item.email === 'string' &&
    item.email.toLowerCase() === acc.email.toLowerCase()
      ? { ...item, httpsUsername: value }
      : item
  );
  await cfg.update('list', updated, vscode.ConfigurationTarget.Global);
  acc.httpsUsername = value;
  return value;
}

/** Expands ~, resolves the path and uses forward slashes (works with Git for Windows). */
function normalizeKeyPath(p: string): string {
  let k = p.trim();
  if (k.startsWith('~')) {
    k = path.join(os.homedir(), k.slice(1));
  }
  return path.resolve(k).replace(/\\/g, '/');
}

function sshCommandFor(acc: Account): string {
  if (!acc.sshKey) {
    throw new Error(`Account "${acc.label}" does not have an SSH key configured.`);
  }
  // core.sshCommand is interpreted by a shell. Single-quote the selected path
  // and escape the only character that can terminate a POSIX shell quote.
  const key = normalizeKeyPath(acc.sshKey).replace(/'/g, `'"'"'`);
  return `ssh -i '${key}' -o IdentitiesOnly=yes`;
}

async function getRemoteNames(cwd: string): Promise<string[]> {
  try {
    const remotes = await git(['remote'], cwd);
    return remotes.stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function getConfig(cwd: string, key: string): Promise<string | undefined> {
  try {
    const r = await git(['config', '--get', key], cwd);
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getRemoteUrl(
  cwd: string,
  name: string,
  kind: 'push' | 'pull'
): Promise<string | undefined> {
  if (!name || name === '.') { return undefined; }
  try {
    const args = ['remote', 'get-url'];
    if (kind === 'push') { args.push('--push'); }
    args.push(name);
    return (await git(args, cwd)).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getTargetRemote(
  cwd: string,
  kind: 'push' | 'pull'
): Promise<{ name: string; url: string } | undefined> {
  const names = await getRemoteNames(cwd);
  if (names.length === 0) { return undefined; }

  let branch: string | undefined;
  try {
    branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)).stdout.trim();
  } catch {
    // Detached HEAD: use repository-level defaults.
  }

  const candidates: Array<string | undefined> = [];
  if (branch && kind === 'push') {
    candidates.push(await getConfig(cwd, `branch.${branch}.pushRemote`));
  }
  if (kind === 'push') {
    candidates.push(await getConfig(cwd, 'remote.pushDefault'));
  }
  if (branch) {
    candidates.push(await getConfig(cwd, `branch.${branch}.remote`));
  }
  candidates.push(names.includes('origin') ? 'origin' : undefined, names[0]);

  for (const name of candidates) {
    if (!name || !names.includes(name)) { continue; }
    const url = await getRemoteUrl(cwd, name, kind);
    if (url) { return { name, url }; }
  }
  return undefined;
}

async function unsetLocalConfig(cwd: string, key: string): Promise<void> {
  try {
    await git(['config', '--local', '--unset-all', key], cwd);
  } catch {
    // Git exits non-zero when the key was not set.
  }
}

interface ConfigChange {
  key: string;
  value: string;
}

async function applyLocalConfigAtomically(cwd: string, changes: ConfigChange[]): Promise<void> {
  const previous = await Promise.all(changes.map(async change => ({
    key: change.key,
    value: await getLocalConfig(cwd, change.key)
  })));

  try {
    for (const change of changes) {
      await git(['config', '--local', change.key, change.value], cwd);
    }
  } catch (error) {
    for (const old of previous.reverse()) {
      try {
        if (old.value === undefined) {
          await unsetLocalConfig(cwd, old.key);
        } else {
          await git(['config', '--local', old.key, old.value], cwd);
        }
      } catch {
        // Preserve the original failure; rollback is best-effort.
      }
    }
    throw error;
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
    return r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function findRepoRoot(start: string): Promise<string | undefined> {
  try {
    const r = await git(['rev-parse', '--show-toplevel'], start);
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getLocalConfig(cwd: string, key: string): Promise<string | undefined> {
  try {
    const r = await git(['config', '--local', '--get', key], cwd);
    const v = r.stdout.trim();
    return v || undefined;
  } catch {
    return undefined; // exit code 1 = key not set
  }
}

async function currentAccount(cwd: string): Promise<Account | undefined> {
  const email = await getLocalConfig(cwd, 'user.email');
  if (!email) { return undefined; }
  return getAccounts().find(a => a.email.toLowerCase() === email.toLowerCase());
}

/** Picks a workspace folder (asks if there are several). */
async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Open a folder that contains a Git repository first.');
    return undefined;
  }
  let folder: vscode.WorkspaceFolder | undefined;
  if (folders.length === 1) {
    folder = folders[0];
  } else {
    const active = vscode.window.activeTextEditor?.document.uri;
    folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!folder) {
      folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select repository' });
    }
  }
  if (!folder) { return undefined; }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeStart = activeUri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(activeUri) === folder
    ? path.dirname(activeUri.fsPath)
    : folder.uri.fsPath;
  const repoRoot = await findRepoRoot(activeStart) ?? await findRepoRoot(folder.uri.fsPath);
  if (!repoRoot) {
    vscode.window.showWarningMessage(`No Git repository was found in "${folder.name}".`);
    return undefined;
  }
  return repoRoot;
}

async function pickAccount(placeHolder: string, cwd?: string): Promise<Account | undefined> {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No Git accounts configured yet.',
      'Add Account'
    );
    if (choice === 'Add Account') {
      await vscode.commands.executeCommand('gitAccounts.addAccount');
    }
    return undefined;
  }
  const current = cwd ? await currentAccount(cwd) : undefined;
  const items = accounts.map(a => ({
    label: (current && current.email === a.email ? '$(check) ' : '$(account) ') + a.label,
    description: a.email,
    detail: a.name,
    acc: a
  }));
  const sel = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  return sel?.acc;
}

/** Writes commit identity and transport-specific authentication into local config. */
async function applyToRepo(cwd: string, acc: Account, remoteUrl?: string): Promise<void> {
  const transport = remoteTransport(remoteUrl);
  const changes: ConfigChange[] = [
    { key: 'user.name', value: acc.name },
    { key: 'user.email', value: acc.email }
  ];

  // Resolve and validate authentication before writing anything, so cancelling
  // setup cannot leave a partially switched repository identity.
  if (transport === 'https') {
    const httpsUsername = await ensureHttpsUsername(acc);
    if (!httpsUsername) {
      throw new Error(`HTTPS setup for "${acc.label || acc.email}" was cancelled.`);
    }
    const context = httpsCredentialContext(remoteUrl!);
    if (context) {
      changes.push({ key: `credential.${context}.username`, value: httpsUsername });
    }
  } else if (transport === 'ssh') {
    if (!acc.sshKey) {
      throw new Error(`Account "${acc.label}" does not have an SSH key configured.`);
    }
    changes.push({ key: 'core.sshCommand', value: sshCommandFor(acc) });
  } else if (!remoteUrl && acc.sshKey) {
    changes.push({ key: 'core.sshCommand', value: sshCommandFor(acc) });
  }

  await applyLocalConfigAtomically(cwd, changes);
}

function refreshBuiltInGit() {
  vscode.commands.executeCommand('git.refresh').then(undefined, () => undefined);
}

/* ------------------------------------------------------------- status bar */

async function updateStatusBar(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { statusBar.hide(); return; }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const folder = (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) || folders[0];
  const start = activeUri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(activeUri) === folder
    ? path.dirname(activeUri.fsPath)
    : folder.uri.fsPath;
  const cwd = await findRepoRoot(start) ?? await findRepoRoot(folder.uri.fsPath);

  if (!cwd) { statusBar.hide(); return; }

  const acc = await currentAccount(cwd);
  const email = await getLocalConfig(cwd, 'user.email');

  if (acc) {
    statusBar.text = `$(account) ${acc.label}`;
    statusBar.tooltip = `Git account for this repo: ${acc.name} <${acc.email}>\nClick to switch`;
    statusBar.backgroundColor = undefined;
  } else if (email) {
    statusBar.text = `$(account) ${email}`;
    statusBar.tooltip = 'Local email is not one of your configured accounts. Click to switch.';
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = '$(warning) Select Git account';
    statusBar.tooltip = 'No account is set for this repo. Click to choose one.';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBar.show();
}

async function promptIfUnset(): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('gitAccounts').get<boolean>('promptOnOpen', true);
  if (!enabled || getAccounts().length === 0) { return; }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const cwd = folder.uri.fsPath;
    if (promptedThisSession.has(cwd)) { continue; }
    if (!(await isGitRepo(cwd))) { continue; }
    if (await getLocalConfig(cwd, 'user.email')) { continue; }

    promptedThisSession.add(cwd);
    const choice = await vscode.window.showWarningMessage(
      `No Git account is set for "${folder.name}". Commits could use the wrong identity.`,
      'Select Account',
      'Not Now'
    );
    if (choice === 'Select Account') {
      const acc = await pickAccount(`Account for ${folder.name}`, cwd);
      if (acc) {
        try {
          const target = await getTargetRemote(cwd, 'push');
          await applyToRepo(cwd, acc, target?.url);
          refreshBuiltInGit();
          await updateStatusBar();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Could not apply account: ${e.message}`);
        }
      }
    }
    // show prompts sequentially so every newly opened repository is covered
  }
}

/* --------------------------------------------------------------- commands */

async function cmdSwitch() {
  const cwd = await pickFolder();
  if (!cwd) { return; }
  const acc = await pickAccount('Select Git account for this repo', cwd);
  if (!acc) { return; }
  try {
    const target = await getTargetRemote(cwd, 'push');
    await applyToRepo(cwd, acc, target?.url);
    refreshBuiltInGit();
    await updateStatusBar();
    vscode.window.showInformationMessage(`This repo now uses "${acc.label}" (${acc.email}).`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Could not apply account: ${e.message}`);
  }
}

async function cmdAddAccount() {
  const label = await vscode.window.showInputBox({
    prompt: 'Label (shown in the popup)',
    placeHolder: 'Work',
    ignoreFocusOut: true
  });
  if (!label) { return; }

  const name = await vscode.window.showInputBox({
    prompt: 'Name for commits (git user.name)',
    ignoreFocusOut: true
  });
  if (!name) { return; }

  const email = await vscode.window.showInputBox({
    prompt: 'Email for commits (git user.email)',
    placeHolder: 'you@company.com',
    ignoreFocusOut: true,
    validateInput: v => (/^\S+@\S+\.\S+$/.test(v) ? undefined : 'Enter a valid email')
  });
  if (!email) { return; }

  const auth = await vscode.window.showQuickPick(
    [
      { label: 'HTTPS and SSH', value: 'both' },
      { label: 'HTTPS', description: 'Use Git Credential Manager', value: 'https' },
      { label: 'SSH', description: 'Use a private SSH key', value: 'ssh' }
    ],
    { placeHolder: 'Which remote types should this account support?' }
  );
  if (!auth) { return; }

  let httpsUsername: string | undefined;
  if (auth.value === 'https' || auth.value === 'both') {
    httpsUsername = await vscode.window.showInputBox({
      prompt: 'Username for HTTPS authentication (credentials stay in Git Credential Manager)',
      placeHolder: 'GitHub, GitLab, or Bitbucket username',
      ignoreFocusOut: true,
      validateInput: v => (v.trim() ? undefined : 'Enter your hosting-service username')
    });
    if (!httpsUsername) { return; }
    httpsUsername = httpsUsername.trim();
  }

  let sshKey: string | undefined;
  if (auth.value === 'ssh' || auth.value === 'both') {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')),
      openLabel: 'Select PRIVATE key (not the .pub file)',
      title: 'Select the private SSH key for this account'
    });
    if (!picked || picked.length === 0) { return; }
    sshKey = picked[0].fsPath.replace(/\\/g, '/');
    if (sshKey.endsWith('.pub')) {
      vscode.window.showErrorMessage('Please select the private key, not the .pub file.');
      return;
    }
  }

  const cfg = vscode.workspace.getConfiguration('gitAccounts');
  const list = cfg.inspect<Account[]>('list')?.globalValue ?? [];
  const updated = [
    ...list.filter(a => a.label !== label),
    { label, name, email, sshKey, httpsUsername }
  ];
  await cfg.update('list', updated, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Account "${label}" saved.`);
}

async function cmdClone() {
  const acc = await pickAccount('Select the account to clone with');
  if (!acc) { return; }

  const url = await vscode.window.showInputBox({
    prompt: 'Repository URL (HTTPS or SSH)',
    placeHolder: 'https://github.com/company/repo.git',
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Enter a repository URL')
  });
  if (!url) { return; }
  const cleanUrl = url.trim();

  const credentialContext = httpsCredentialContext(cleanUrl);
  if (credentialContext) {
    const httpsUsername = await ensureHttpsUsername(acc);
    if (!httpsUsername) { return; }
  }
  if (remoteTransport(cleanUrl) === 'ssh' && !acc.sshKey) {
    vscode.window.showErrorMessage(
      `Account "${acc.label}" does not have an SSH key configured.`
    );
    return;
  }

  const dest = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Clone into this folder',
    title: 'Choose the parent folder for the clone'
  });
  if (!dest || dest.length === 0) { return; }

  const repoName =
    cleanUrl.replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() || 'repo';
  const parent = dest[0].fsPath;
  const target = path.join(parent, repoName);
  const transport = remoteTransport(cleanUrl);
  const sshCmd = transport === 'ssh' ? sshCommandFor(acc) : undefined;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Cloning ${repoName} as ${acc.label}…` },
      async () => {
        const cloneArgs = ['clone'];
        if (credentialContext) {
          cloneArgs.push('-c', `credential.${credentialContext}.username=${acc.httpsUsername}`);
        } else if (sshCmd) {
          cloneArgs.push('-c', `core.sshCommand=${sshCmd}`);
        }
        cloneArgs.push(cleanUrl, repoName);
        await git(
          cloneArgs,
          parent,
          sshCmd
            ? { GIT_SSH_COMMAND: sshCmd, GIT_TERMINAL_PROMPT: '0' }
            : { GIT_TERMINAL_PROMPT: '0' }
        );
        await applyToRepo(target, acc, cleanUrl);
      }
    );
  } catch (e: any) {
    out.show(true);
    vscode.window.showErrorMessage(`Clone failed: ${e.message}`);
    return;
  }

  const open = await vscode.window.showInformationMessage(
    `Cloned ${repoName} with "${acc.label}".`,
    'Open',
    'Open in New Window'
  );
  if (open) {
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(target),
      { forceNewWindow: open === 'Open in New Window' }
    );
  }
}

async function runWithAccount(kind: 'push' | 'pull') {
  const cwd = await pickFolder();
  if (!cwd) { return; }
  const acc = await pickAccount(`Account to ${kind} with`, cwd);
  if (!acc) { return; }

  try {
    const target = await getTargetRemote(cwd, kind);
    await applyToRepo(cwd, acc, target?.url);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `git ${kind} as ${acc.label}…` },
      async () => {
        const env = remoteTransport(target?.url) === 'ssh'
          ? { GIT_SSH_COMMAND: sshCommandFor(acc), GIT_TERMINAL_PROMPT: '0' }
          : { GIT_TERMINAL_PROMPT: '0' };
        try {
          await git([kind], cwd, env);
        } catch (e: any) {
          if (kind === 'push' && /no upstream branch|has no upstream/i.test(e.message)) {
            await git(['push', '-u', 'origin', 'HEAD'], cwd, env);
          } else {
            throw e;
          }
        }
      }
    );
    refreshBuiltInGit();
    await updateStatusBar();
    vscode.window.showInformationMessage(`git ${kind} finished using "${acc.label}".`);
  } catch (e: any) {
    out.show(true);
    vscode.window.showErrorMessage(`git ${kind} failed: ${e.message}`);
  }
}

async function cmdTestConnection() {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const acc = await pickAccount('Test SSH connection for which account?', cwd);
  if (!acc) { return; }
  if (!acc.sshKey) {
    vscode.window.showInformationMessage(
      `${acc.label} uses HTTPS. Authentication is handled by Git Credential Manager during clone, pull, or push.`
    );
    return;
  }
  const host = vscode.workspace.getConfiguration('gitAccounts').get<string>('testHost', 'github.com');

  const args = [
    '-i', normalizeKeyPath(acc.sshKey),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-T', `git@${host}`
  ];
  out.appendLine(`> ssh ${formatCommandArgs(args)}`);

  execFile('ssh', args, { windowsHide: true }, (_err, stdout, stderr) => {
    // GitHub exits with code 1 even on success, so read the text instead of the exit code.
    const text = `${stdout}\n${stderr}`.trim();
    out.appendLine(redactSensitiveText(text));
    if (/successfully authenticated|authenticated via ssh key|welcome to gitlab|logged in as/i.test(text)) {
      const firstLine = text.split(/\r?\n/).find(l => l.trim()) ?? 'Authenticated.';
      vscode.window.showInformationMessage(`${acc.label}: ${firstLine}`);
    } else if (/passphrase|permission denied/i.test(text)) {
      vscode.window.showErrorMessage(
        `${acc.label}: authentication failed. Check the key is added to the right account. ` +
        `If the key has a passphrase, load it with ssh-add first.`
      );
      out.show(true);
    } else {
      vscode.window.showErrorMessage(`${acc.label}: ${text.split(/\r?\n/)[0] || 'SSH test failed.'}`);
      out.show(true);
    }
  });
}

/* ------------------------------------------------------------- activation */

export function activate(ctx: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'gitAccounts.switch';
  ctx.subscriptions.push(statusBar, out);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('gitAccounts.switch', cmdSwitch),
    vscode.commands.registerCommand('gitAccounts.clone', cmdClone),
    vscode.commands.registerCommand('gitAccounts.pushWith', () => runWithAccount('push')),
    vscode.commands.registerCommand('gitAccounts.pullWith', () => runWithAccount('pull')),
    vscode.commands.registerCommand('gitAccounts.addAccount', cmdAddAccount),
    vscode.commands.registerCommand('gitAccounts.testConnection', cmdTestConnection),
    vscode.commands.registerCommand('gitAccounts.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'gitAccounts')
    )
  );

  // Keep the status bar in sync.
  const watchers: vscode.Disposable[] = [];
  const rewatch = () => {
    watchers.splice(0).forEach(w => w.dispose());
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      for (const pattern of ['**/.git/config', '**/.git']) {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, pattern));
        w.onDidChange(updateStatusBar);
        w.onDidCreate(updateStatusBar);
        w.onDidDelete(updateStatusBar);
        watchers.push(w);
      }
    }
  };
  rewatch();
  ctx.subscriptions.push(
    { dispose: () => watchers.forEach(w => w.dispose()) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => { rewatch(); updateStatusBar(); promptIfUnset(); }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gitAccounts')) { updateStatusBar(); }
    })
  );

  updateStatusBar().then(promptIfUnset);
}

export function deactivate() { /* nothing to clean up */ }
