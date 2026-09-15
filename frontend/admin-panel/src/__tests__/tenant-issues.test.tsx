import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TenantIssuesChip from '@/components/tenants/TenantIssuesChip';
import TenantIssuesBanner from '@/components/tenants/TenantIssuesBanner';
import { summariseIssues, type TenantIssue } from '@/hooks/use-tenant-issues';

const issue = (over: Partial<TenantIssue> = {}): TenantIssue => ({
  tenantId: 't1',
  kind: 'mailbox_quota',
  severity: 'warning',
  objectLabel: 'user@example.test',
  detail: 'Mailbox 90% full (1350/1500 MB)',
  actionPath: '/email',
  since: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  ...over,
});

describe('TenantIssuesChip', () => {
  it('renders nothing for a healthy tenant — an always-present badge is not a signal', () => {
    const { container } = render(<TenantIssuesChip issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the issues', () => {
    render(<TenantIssuesChip issues={[issue(), issue({ kind: 'bandwidth_capped' })]} />);
    expect(screen.getByTestId('tenant-issues-chip')).toHaveTextContent('2 issues');
  });

  it('singularises one issue', () => {
    render(<TenantIssuesChip issues={[issue()]} />);
    expect(screen.getByTestId('tenant-issues-chip')).toHaveTextContent('1 issue');
  });

  it('goes red when ANY issue is critical', () => {
    render(<TenantIssuesChip issues={[issue(), issue({ severity: 'critical' })]} />);
    expect(screen.getByTestId('tenant-issues-chip').className).toMatch(/red/);
  });

  it('stays amber when every issue is a warning', () => {
    render(<TenantIssuesChip issues={[issue()]} />);
    expect(screen.getByTestId('tenant-issues-chip').className).toMatch(/amber/);
  });
});

describe('TenantIssuesBanner', () => {
  it('renders nothing when the tenant is healthy', () => {
    const { container } = render(<TenantIssuesBanner issues={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the object, the detail and the age of each issue', () => {
    render(<TenantIssuesBanner issues={[issue()]} />);
    const row = screen.getByTestId('tenant-issue-mailbox_quota');
    expect(row).toHaveTextContent('user@example.test');
    expect(row).toHaveTextContent('Mailbox 90% full (1350/1500 MB)');
    expect(row).toHaveTextContent('5h');
  });

  it('lists every issue, not just the worst one', () => {
    render(<TenantIssuesBanner issues={[issue(), issue({ kind: 'bandwidth_capped', objectLabel: 'Example Ltd' })]} />);
    expect(screen.getByTestId('tenant-issue-mailbox_quota')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-issue-bandwidth_capped')).toBeInTheDocument();
  });

  it('omits the age when the condition is not time-tracked', () => {
    render(<TenantIssuesBanner issues={[issue({ since: null })]} />);
    expect(screen.getByTestId('tenant-issue-mailbox_quota').textContent).not.toMatch(/·/);
  });
});

describe('summariseIssues', () => {
  it('lets one critical drive the badge', () => {
    expect(summariseIssues([issue(), issue({ severity: 'critical' })]).severity).toBe('critical');
  });

  it('reports nothing for an empty list', () => {
    expect(summariseIssues([])).toEqual({ count: 0, severity: null });
  });
});
