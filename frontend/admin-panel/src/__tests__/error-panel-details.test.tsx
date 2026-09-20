import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ErrorPanel from '../components/ErrorPanel';
import { describeDeploymentError } from '../lib/describe-deployment-error';

/**
 * What a tenant actually saw when a deploy was refused for lack of memory:
 * the Kubernetes API's whole Status body, line-clamped to two lines. This
 * drives the rendered panel end to end — decode, summary, expander, table.
 */
const RAW_K8S_BODY =
  'HTTP-Code: 403\nMessage: Forbidden\nBody: ' +
  JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message:
      'pods "moodle-7f8b79576f-9lrtv" is forbidden: exceeded quota: tenant-example-quota, ' +
      'requested: limits.memory=512Mi,requests.memory=512Mi, ' +
      'used: limits.memory=544Mi,requests.memory=544Mi, ' +
      'limited: limits.memory=1Gi,requests.memory=1Gi',
    reason: 'Forbidden',
    code: 403,
  });

const panel = () => render(<ErrorPanel error={describeDeploymentError(RAW_K8S_BODY)} />);

describe('ErrorPanel for a quota rejection', () => {
  it('shows a plain sentence and no JSON before anything is expanded', () => {
    const { container } = panel();
    expect(screen.getByText('Not enough memory in your plan')).toBeInTheDocument();
    expect(
      screen.getByText(/only 480Mi of your 1Gi plan is free/),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain('"kind"');
    expect(container.textContent).not.toContain('apiVersion');
  });

  it('keeps the details collapsed until asked', () => {
    panel();
    expect(screen.queryByTestId('error-panel-details')).not.toBeInTheDocument();
    expect(screen.getByText('More details')).toBeInTheDocument();
  });

  it('opens a table — not a JSON dump — with the three numbers that matter', () => {
    panel();
    fireEvent.click(screen.getByTestId('error-panel-details-toggle'));

    const details = screen.getByTestId('error-panel-details');
    expect(within(details).getByRole('table')).toBeInTheDocument();
    for (const [label, value] of [
      ['Memory requested', '512Mi'],
      ['Memory already in use', '544Mi'],
      ['Memory plan limit', '1Gi'],
      ['Memory free', '480Mi'],
      ['Memory short by', '32Mi'],
    ]) {
      const row = within(details).getByRole('rowheader', { name: label }).closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText(value)).toBeInTheDocument();
    }
  });

  // The expander is what operators copy into a support ticket — decoding must
  // not mean discarding.
  it('still carries the raw upstream string inside the expander', () => {
    panel();
    fireEvent.click(screen.getByTestId('error-panel-details-toggle'));
    const details = screen.getByTestId('error-panel-details');
    expect(details.textContent).toContain('"kind":"Status"');
  });

  // Retrying cannot free memory; offering the button invites a loop.
  it('offers no Retry button for a quota rejection', () => {
    render(
      <ErrorPanel
        error={describeDeploymentError(RAW_K8S_BODY)}
        onRetry={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('does offer Retry for a failure that could succeed on a second try', () => {
    render(
      <ErrorPanel
        error={describeDeploymentError('ImagePullBackOff: registry timed out')}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
