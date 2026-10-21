export type RemoteTransport = 'https' | 'ssh' | 'other';

export function remoteTransport(remoteUrl: string | undefined): RemoteTransport {
  if (!remoteUrl) { return 'other'; }
  if (/^https?:\/\//i.test(remoteUrl)) { return 'https'; }
  if (/^ssh:\/\//i.test(remoteUrl) || /^[^/@\s]+@[^/:\s]+:/i.test(remoteUrl)) {
    return 'ssh';
  }
  return 'other';
}

export function httpsCredentialContext(remoteUrl: string): string | undefined {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(https?:\/\/)([^/@\s]+)@/gi, '$1***@')
    .replace(/([?&](?:access_token|auth|password|token)\s*=)[^&\s]+/gi, '$1***')
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)[^\s]+/gi, '$1***');
}

export function formatCommandArgs(args: string[]): string {
  return args.map((arg, index) => {
    const safe = index > 0 && args[index - 1] === '-i'
      ? '<key-path>'
      : redactSensitiveText(arg);
    return /\s/.test(safe) ? JSON.stringify(safe) : safe;
  }).join(' ');
}
