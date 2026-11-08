/**
 * Minimal structured logger (JSON lines). Never pass secrets or full email
 * bodies here; customer emails are masked with maskEmail().
 */
type Fields = Record<string, unknown>;

let silent = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;

function write(level: string, msg: string, fields?: Fields) {
  if (silent) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  info: (msg: string, f?: Fields) => write('info', msg, f),
  warn: (msg: string, f?: Fields) => write('warn', msg, f),
  error: (msg: string, f?: Fields) => write('error', msg, f),
  setSilent: (v: boolean) => {
    silent = v;
  },
};

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}
