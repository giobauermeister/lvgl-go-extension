import { spawn, ChildProcess } from 'node:child_process';
import { Config, Command, expand } from './config';

export class Builder {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private pending = false;
  private stopped = false;
  private child?: ChildProcess;
  private secrets = new Set<string>();

  constructor(
    private config: Config,
    private log: (message: string) => void,
    private state: (status: 'building' | 'ready' | 'error', message?: string) => void,
    private publish: () => Promise<void>,
    private prepare: () => Promise<void> = async () => {}
  ) {}

  request(immediate = false): void {
    if (this.stopped) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, immediate ? 0 : this.config.debounceMs);
  }

  private async drain(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = this.run();
    try { await this.active; } finally {
      this.active = undefined;
      // Events received during compilation get one subsequent build, after settling.
      if (this.pending && !this.stopped && !this.timer) this.request();
    }
  }

  private async run(): Promise<void> {
    this.pending = false;
    this.state('building');
    try {
      if (this.stopped) return;
      await this.prepare();
      for (const step of this.config.build) {
        if (this.stopped) return;
        await this.execute(step);
      }
      if (this.stopped) return;
      // Do not publish a build known to have changed underneath the compiler.
      if (this.pending) return;
      await this.publish();
      if (!this.stopped) this.state('ready');
    } catch (error) {
      if (!this.stopped) {
        this.log(this.redact(String(error)));
        this.state('error', 'Build failed. See LVGL Go output in VS Code.');
      }
    }
  }

  private redact(text: string): string {
    for (const value of [...this.secrets].sort((a, b) => b.length - a.length)) text = text.split(value).join('[REDACTED]');
    return text;
  }

  private execute(step: Command): Promise<void> {
    for (const value of [step.command, ...step.args, ...Object.values(step.env ?? {})]) {
      for (const match of value.matchAll(/\$\{env:([^}]+)\}/g)) {
        const secret = process.env[match[1]];
        if (secret) this.secrets.add(secret);
      }
    }
    const command = expand(step.command, {});
    const args = step.args.map(arg => expand(arg, {}));
    const env = { ...process.env, ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, expand(value, {})])) };
    this.log(this.redact(`> ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}`));
    return new Promise((resolve, reject) => {
      // A process group lets Stop terminate compiler children on POSIX too.
      const child = spawn(command, args, { cwd: step.cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true });
      this.child = child;
      // Buffer lines so environment values split over chunks are still redacted.
      const write = () => {
        let buffer = '';
        return (chunk?: Buffer) => {
          buffer += chunk?.toString() ?? '';
          const lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) this.log(this.redact(line));
          if (!chunk && buffer) { this.log(this.redact(buffer)); buffer = ''; }
        };
      };
      const stdout = write(), stderr = write();
      child.stdout?.on('data', stdout);
      child.stderr?.on('data', stderr);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        stdout(); stderr();
        if (this.child === child) this.child = undefined;
        if (code === 0) resolve();
        else reject(new Error(`Command exited with ${signal ?? code}: ${command}`));
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const child = this.child;
    let forceKill: NodeJS.Timeout | undefined;
    if (child?.pid) {
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          } else process.kill(-child.pid!, signal);
        } catch { /* Already exited. */ }
      };
      kill('SIGTERM');
      forceKill = setTimeout(() => kill('SIGKILL'), 2000);
    }
    try { await this.active; } finally { clearTimeout(forceKill); }
  }
}
