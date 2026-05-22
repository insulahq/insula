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
