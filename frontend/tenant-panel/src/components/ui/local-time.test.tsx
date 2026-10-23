import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LocalTime from './LocalTime';
import { formatTimestamp, localZoneTitle } from '@/lib/format-timestamp';

// Berlin, so a daylight-saving change can fall inside a listed window:
// summer time (UTC+2) ends on the last Sunday of October.
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Berlin');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('formatTimestamp', () => {
  const at = new Date('2026-10-23T12:05:09.000Z');

  it('reads the viewer zone by default, to the minute', () => {
    expect(formatTimestamp(at)).toBe('2026-10-23 14:05');
    expect(formatTimestamp(at, { seconds: true })).toBe('2026-10-23 14:05:09');
  });

  it('reads UTC on request', () => {
    expect(formatTimestamp(at, { seconds: true, utc: true })).toBe('2026-10-23 12:05:09');
  });

  it('rolls the date over with the zone, not with UTC', () => {
    expect(formatTimestamp(new Date('2026-10-23T23:30:00.000Z'))).toBe('2026-10-24 01:30');
  });

  it('names the zone in the header tooltip', () => {
    expect(localZoneTitle()).toContain('Europe/Berlin');
  });
});

describe('LocalTime', () => {
  it('shows local time, UTC on hover, and the instant as dateTime', () => {
    render(<LocalTime iso="2026-10-23T12:05:09.000Z" seconds />);
    const time = screen.getByText('2026-10-23 14:05:09');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('title', '2026-10-23 12:05:09 UTC');
    expect(time).toHaveAttribute('dateTime', '2026-10-23T12:05:09.000Z');
  });

  it('a row from before a daylight-saving change names its own offset', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T09:00:00.000Z')); // Berlin is UTC+1 today
    render(
      <>
        <LocalTime iso="2026-10-24T12:00:00.000Z" />
        <LocalTime iso="2026-10-26T12:00:00.000Z" />
      </>,
    );
    const before = screen.getByText('2026-10-24 14:00').closest('time')!;
    expect(before).toHaveTextContent('2026-10-24 14:00UTC+2');
    expect(screen.getByText('2026-10-26 13:00').closest('time')).toHaveTextContent(/^2026-10-26 13:00$/);
  });

  it('renders a dash instead of throwing on an unparseable instant', () => {
    render(<LocalTime iso="not a date" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
