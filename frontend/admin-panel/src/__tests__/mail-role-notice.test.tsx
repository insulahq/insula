import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DrainImpact } from '@insula/api-contracts';
import MailRoleNotice from '../components/nodes/MailRoleNotice';

// Production: mail's only failover target was cordoned for a drain;
// the mail node then went down and mail stayed down for the whole outage. The
// drain modal and the cordon toggle now say what a cordon leaves mail.

type MailRole = NonNullable<DrainImpact['mailRole']>;
const role = (o: Partial<MailRole>): MailRole => ({
  role: 'secondary', activeNode: 's1', autoFailoverEnabled: true, failoverThresholdSeconds: 300,
  otherFailoverTargets: [], onlyStandbyCopy: true, ...o,
});
const show = (r: MailRole | null) => render(
  <MemoryRouter><MailRoleNotice mailRole={r} nodeName="s2" /></MemoryRouter>,
);

describe('MailRoleNotice', () => {
  it('cordoning the only failover target: says mail cannot fail over and links to Placement', () => {
    show(role({}));
    const notice = screen.getByTestId('mail-role-notice');
    expect(notice).toHaveAttribute('data-stranded', 'true');
    expect(notice).toHaveTextContent('While s2 is cordoned, mail cannot fail over');
    expect(notice).toHaveTextContent('holds the only standby copy');
    expect(notice).toHaveTextContent('If s1 goes down meanwhile, mail stays down');
    expect(screen.getByTestId('mail-role-notice-placement-link')).toHaveAttribute('href', '/email/operations/placement');
  });

  it('another target left: says where mail fails over instead, no link', () => {
    show(role({ otherFailoverTargets: ['s3'], onlyStandbyCopy: false }));
    expect(screen.getByTestId('mail-role-notice')).toHaveTextContent('mail fails over to s3 instead.');
    expect(screen.queryByTestId('mail-role-notice-placement-link')).toBeNull();
  });

  it('the node mail runs on: the drain leaves it, and where it would fail over', () => {
    show(role({ role: 'active', otherFailoverTargets: ['s3'] }));
    expect(screen.getByTestId('mail-role-notice')).toHaveTextContent('Mail runs on this node');
    expect(screen.getByTestId('mail-role-notice')).toHaveTextContent('fails over to s3 after 5 min');
  });

  it('the node mail runs on with automatic failover off says so', () => {
    show(role({ role: 'active', autoFailoverEnabled: false, otherFailoverTargets: ['s3'] }));
    expect(screen.getByTestId('mail-role-notice')).toHaveTextContent('Automatic failover is off');
  });

  it('renders nothing for a node with no mail role', () => {
    show(null);
    expect(screen.queryByTestId('mail-role-notice')).toBeNull();
  });
});
