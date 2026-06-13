import { describe, it, expect } from 'vitest';
import { parseCrontabLine, classifyCommand, cronLabel } from './cron-sync.js';

describe('parseCrontabLine', () => {
  it('splits a standard 5-field line into schedule + command', () => {
    const r = parseCrontabLine('*/15 * * * * /usr/bin/php /var/www/cron.php run');
    expect(r).toEqual({ schedule: '*/15 * * * *', command: '/usr/bin/php /var/www/cron.php run' });
  });

  it('translates standard @macros to numeric 5-field schedules', () => {
    expect(parseCrontabLine('@daily /opt/backup.sh')).toEqual({ schedule: '0 0 * * *', command: '/opt/backup.sh' });
    expect(parseCrontabLine('@hourly run')).toMatchObject({ schedule: '0 * * * *' });
    expect(parseCrontabLine('@weekly run')).toMatchObject({ schedule: '0 0 * * 0' });
  });

  it('skips comments, blanks, and env-assignment lines', () => {
    expect(parseCrontabLine('# a comment')).toHaveProperty('skip');
    expect(parseCrontabLine('   ')).toHaveProperty('skip');
    expect(parseCrontabLine('MAILTO=ops@acme.example')).toMatchObject({ skip: expect.stringContaining('MAILTO') });
  });

  it('skips @reboot and named schedule fields (unsupported by the numeric validator)', () => {
    expect(parseCrontabLine('@reboot /opt/start.sh')).toMatchObject({ skip: expect.stringContaining('@reboot') });
    expect(parseCrontabLine('0 0 * * MON /opt/weekly.sh')).toHaveProperty('skip');
  });

  it('skips malformed lines and schedule-only lines', () => {
    expect(parseCrontabLine('* * * *')).toHaveProperty('skip');
    expect(parseCrontabLine('*/5 * * * *')).toHaveProperty('skip'); // no command
  });
});

describe('classifyCommand', () => {
  it('maps a plain curl/wget of an http URL to an enabled webcron', () => {
    expect(classifyCommand('curl -s https://acme.example/cron.php')).toEqual({ type: 'webcron', url: 'https://acme.example/cron.php', httpMethod: 'GET' });
    expect(classifyCommand('/usr/bin/wget -q -O /dev/null http://acme.example/tick')).toMatchObject({ type: 'webcron', httpMethod: 'GET' });
  });

  it('detects POST/PUT methods from flags', () => {
    expect(classifyCommand('curl -X POST https://acme.example/run')).toMatchObject({ type: 'webcron', httpMethod: 'POST' });
    expect(classifyCommand('curl --data x=1 https://acme.example/run')).toMatchObject({ type: 'webcron', httpMethod: 'POST' });
    expect(classifyCommand('curl -X PUT https://acme.example/run')).toMatchObject({ type: 'webcron', httpMethod: 'PUT' });
  });

  it('treats shell-composed or non-fetch commands as deployment commands', () => {
    expect(classifyCommand('php /var/www/cron.php')).toEqual({ type: 'deployment' });
    expect(classifyCommand('curl https://acme.example/a && rm -rf /tmp/x')).toEqual({ type: 'deployment' });
    expect(classifyCommand('curl https://acme.example/a | bash')).toEqual({ type: 'deployment' });
    expect(classifyCommand('echo hi > /tmp/x')).toEqual({ type: 'deployment' });
  });

  it('falls back to deployment when no valid http URL is present', () => {
    expect(classifyCommand('curl -s localhost:8080/cron')).toEqual({ type: 'deployment' });
    expect(classifyCommand('wget ftp://acme.example/file')).toEqual({ type: 'deployment' });
  });
});

describe('cronLabel', () => {
  it('numbers and truncates the raw line', () => {
    expect(cronLabel(0, '*/15 * * * * /usr/bin/php /var/www/cron.php')).toMatch(/^cron 1: /);
    expect(cronLabel(4, 'x'.repeat(200)).length).toBeLessThanOrEqual(70);
  });
});
