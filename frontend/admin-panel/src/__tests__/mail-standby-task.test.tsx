import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Making a node a mail standby — choosing a secondary or tertiary, or moving
// the standby — starts a full first copy on it. The save opens that copy's
// Task Center task, and the page's "preparing" notice re-opens it.

const mutateAsync = vi.fn();
const placement = {
  primaryNode: 'n1', secondaryNode: null, tertiaryNode: null, activeNode: 'n1',
  drState: 'healthy', autoFailoverEnabled: false, failoverThresholdSeconds: 300, lastFailoverAt: null,
  portExposureMode: 'thisNodeOnly', readyNodeCount: 2, readyServerNodeCount: 2, drift: null, lastFailedMigration: null,
  candidateNodes: ['n1', 'n2'].map((hostname) => ({ hostname, role: 'server', ready: true, freeMemoryBytes: 8e9, freeDiskBytes: 100e9 })),
};
vi.mock('@/hooks/use-mail-placement', () => ({
  PLACEMENT_KEY: ['mail', 'placement'],
  useMailPlacement: () => ({ data: { data: placement }, isLoading: false, isError: false }),
  useUpdateMailPlacement: () => ({ mutateAsync, isPending: false, isError: false, error: null }),
  useMailFailover: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useMailFailback: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
}));
vi.mock('@/hooks/use-mail-migration', () => ({
  useStartMailMigration: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
}));
vi.mock('@/hooks/use-mail-recovery', () => ({
  useMailRecoveryStatus: () => ({ data: undefined, isLoading: false }),
  useStartMailRecover: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/use-node-labels', () => ({ useNodeLabel: () => (n: string) => n }));
vi.mock('@/components/nodes/NodeName', () => ({ default: ({ name }: { name: string }) => <>{name}</> }));

let standby: { reports: unknown[]; preparing?: Array<{ node: string; since: string; state?: string; taskId?: string }> } = { reports: [] };
vi.mock('@/hooks/use-mail-standby-reports', () => ({
  useMailStandbyReports: () => ({ data: { data: standby }, isLoading: false, isError: false }),
}));

const task = {
  id: '22222222-2222-4222-8222-222222222222', kind: 'mail.standby-prepare', refId: 'r', scope: 'admin', userId: 'u1', tenantId: null,
  label: 'Prepare the mail standby on n2', status: 'running', progressPct: null,
  progressText: 'Copying the mail store to n2: 3 min so far, about 44.0 GB in all',
  target: { type: 'modal', modal: 'mail-operation', modalProps: { node: 'n2' } }, errorMessage: null,
  details: { steps: [
    { name: 'Make n2 a mail standby', state: 'done' },
    { name: 'Start the standby copier', state: 'done' },
    { name: 'Copy the mail store to n2', state: 'running' },
  ] },
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null, clearedAt: null, parentTaskId: null,
};
vi.mock('@/hooks/use-task-center', () => ({
  TASK_CENTER_QUERY_KEY: ['task-center', 'me'],
  useTaskCenter: () => ({ data: { data: { tasks: [task] } }, isLoading: false, isError: false }),
}));

import MailDrCard from '../components/MailDrCard';
import { MailStandbyPreparingNotice } from '../components/email/MailStandbyFreshness';

const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  mutateAsync.mockReset();
  standby = { reports: [] };
});

describe('saving a placement that makes a node a standby', () => {
  it("opens the new standby's task with its steps", async () => {
    mutateAsync.mockResolvedValue({ data: { updated: true, standbyTasks: [{ node: 'n2', taskId: task.id }] } });
    wrap(<MailDrCard />);
    fireEvent.change(screen.getByTestId('mail-dr-secondary-node'), { target: { value: 'n2' } });
    fireEvent.click(screen.getByTestId('mail-dr-save'));
    const modal = await screen.findByTestId('mail-task-progress-modal');
    expect(modal).toHaveTextContent('Prepare the mail standby on n2');
    expect(screen.getByTestId('mail-task-progress-steps')).toHaveTextContent('Copy the mail store to n2');
    expect(screen.getByTestId('mail-task-progress-text')).toHaveTextContent('3 min so far');
  });

  it('a save that made no node a standby opens nothing (an older backend says nothing either)', async () => {
    mutateAsync.mockResolvedValue({ data: { updated: true } });
    wrap(<MailDrCard />);
    fireEvent.change(screen.getByTestId('mail-dr-secondary-node'), { target: { value: 'n2' } });
    fireEvent.click(screen.getByTestId('mail-dr-save'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(screen.queryByTestId('mail-task-progress-modal')).toBeNull();
  });
});

describe('MailStandbyPreparingNotice', () => {
  it('"View progress" opens the first copy\'s task', () => {
    standby = { reports: [], preparing: [{ node: 'n2', since: new Date().toISOString(), state: 'preparing', taskId: task.id }] };
    wrap(<MailStandbyPreparingNotice />);
    fireEvent.click(screen.getByTestId('mail-standby-preparing-view-n2'));
    expect(screen.getByTestId('mail-task-progress-modal')).toHaveTextContent('Prepare the mail standby on n2');
  });

  it('the open modal stays when the copy finishes and the notice goes', () => {
    standby = { reports: [], preparing: [{ node: 'n2', since: new Date().toISOString(), state: 'preparing', taskId: task.id }] };
    const view = wrap(<MailStandbyPreparingNotice />);
    fireEvent.click(screen.getByTestId('mail-standby-preparing-view-n2'));
    standby = { reports: [], preparing: [] };
    view.rerender(<QueryClientProvider client={new QueryClient()}><MailStandbyPreparingNotice /></QueryClientProvider>);
    expect(screen.queryByTestId('mail-standby-preparing-notice')).toBeNull();
    expect(screen.getByTestId('mail-task-progress-modal')).toBeInTheDocument();
  });

  it('no button for a copy without a task (a standby labelled by an older platform-api)', () => {
    standby = { reports: [], preparing: [{ node: 'n2', since: new Date().toISOString() }] };
    wrap(<MailStandbyPreparingNotice />);
    expect(screen.getByTestId('mail-standby-preparing-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-standby-preparing-view-n2')).toBeNull();
  });
});
