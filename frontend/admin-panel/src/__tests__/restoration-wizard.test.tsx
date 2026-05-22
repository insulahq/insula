import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import RestorationWizard, {
  type RestoreArtifact,
  type RestoreSelection,
} from '../components/backups/RestorationWizard';

function wrap(node: React.ReactNode) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

const snapshotArtifact: RestoreArtifact = {
  kind: 'snapshot',
  id: 'snap-1',
  displayName: 'tenant-acme/pvc-data',
  sizeBytes: 1024 * 1024 * 50,
  createdAt: '2026-05-22T00:00:00.000Z',
};

const bundleArtifact: RestoreArtifact = {
  kind: 'tenant-bundle',
  id: 'bundle-1',
  displayName: 'acme/bundle-2026-05-22',
  cartUrl: '/backups/restore?cartId=bundle-1',
};

describe('RestorationWizard', () => {
  it('renders the artifact header with display name + verb', () => {
    render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ));
    expect(screen.getByText(/Restore snapshot/)).toBeInTheDocument();
    expect(screen.getByText('tenant-acme/pvc-data')).toBeInTheDocument();
  });

  it('shows the "Pick components" option only for tenant-bundle artifacts', () => {
    const { rerender } = render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ));
    expect(screen.queryByText(/Pick components/)).toBeNull();

    rerender(wrap(
      <RestorationWizard
        artifact={bundleArtifact}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ));
    expect(screen.getByText(/Pick components/)).toBeInTheDocument();
  });

  it('walks through Next → Next → Start restore and submits the selection', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ taskId: 'task-123' });
    const onClose = vi.fn();
    const onCompleted = vi.fn();

    render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        onSubmit={onSubmit}
        onClose={onClose}
        onCompleted={onCompleted}
      />,
    ));

    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    fireEvent.click(screen.getByTestId('restoration-wizard-start'));

    // Resolve the promise + run effects.
    await Promise.resolve();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const selection = onSubmit.mock.calls[0][0] as RestoreSelection;
    expect(selection.scope).toBe('all');
    expect(selection.location).toBe('side-by-side');
    expect(onCompleted).toHaveBeenCalledWith('task-123');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hideWhereStep skips Step 2 entirely and shows 2 tabs instead of 3', () => {
    render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        hideWhereStep
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ));
    // Tab labels reflow: "1. What" + "2. Confirm" (no "Where").
    expect(screen.getByText(/1. What/)).toBeInTheDocument();
    expect(screen.getByText(/2. Confirm/)).toBeInTheDocument();
    expect(screen.queryByText(/3. Confirm/)).toBeNull();
    // One Next click should jump directly to Confirm (Step 3 internally).
    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    expect(screen.getByTestId('restoration-wizard-start')).toBeInTheDocument();
  });

  it('blockSubmit disables the Start button + renders the reason in rose-red', () => {
    render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        hideWhereStep
        blockSubmit="Another PITR is in flight (snapshot=snap-99)"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ));
    // Step over to Confirm.
    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    const start = screen.getByTestId('restoration-wizard-start');
    expect(start).toBeDisabled();
    const reason = screen.getByTestId('restoration-wizard-block-reason');
    expect(reason).toHaveTextContent('Another PITR is in flight');
  });

  it('submitPending shows a neutral spinner banner and disables Start (loading != failure)', () => {
    render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        hideWhereStep
        submitPending="Running prechecks against snapshot + cluster…"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ));
    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    const pending = screen.getByTestId('restoration-wizard-submit-pending');
    expect(pending).toHaveTextContent('Running prechecks');
    // Crucially the rose-red error banner is NOT shown alongside it.
    expect(screen.queryByTestId('restoration-wizard-block-reason')).toBeNull();
    expect(screen.getByTestId('restoration-wizard-start')).toBeDisabled();
  });

  it('surfaces submit errors without closing the modal', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('target unreachable'));
    const onClose = vi.fn();

    render(wrap(
      <RestorationWizard
        artifact={snapshotArtifact}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ));

    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    fireEvent.click(screen.getByTestId('restoration-wizard-next'));
    fireEvent.click(screen.getByTestId('restoration-wizard-start'));

    // Let the rejected promise propagate through the handler's finally
    // block. The `await screen.findByText` polls until the error
    // string appears in the DOM, accommodating any extra render the
    // setSubmitting(false) call queues up.
    expect(await screen.findByText('target unreachable')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
