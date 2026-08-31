import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExtraMountsEditor, { extraMountErrors, type ExtraMountRow } from './ExtraMountsEditor';

const row = (over: Partial<ExtraMountRow> = {}): ExtraMountRow =>
  ({ folder: 'shared-assets', mount_path: '/var/www/html/media', read_only: false, ...over });

describe('extraMountErrors', () => {
  it('accepts a valid row', () => {
    expect(extraMountErrors([row()])).toEqual({});
  });
  it('ignores a row the user added but has not filled in', () => {
    // Adding an empty row then submitting shouldn't look like a validation
    // failure — the row simply isn't a mount yet.
    expect(extraMountErrors([{ folder: '', mount_path: '', read_only: false }])).toEqual({});
  });
  it('reports a half-filled row', () => {
    expect(extraMountErrors([row({ mount_path: '' })])['0.mount_path']).toMatch(/required/);
  });
  it('rejects a reserved mount path with the server’s own message', () => {
    expect(extraMountErrors([row({ mount_path: '/etc' })])['0.mount_path'])
      .toMatch(/image's own filesystem/);
  });
  it('rejects folder traversal', () => {
    expect(extraMountErrors([row({ folder: '../escape' })])['0.folder']).toMatch(/segments may use/);
  });
  it('flags a duplicate path against the earlier row', () => {
    const errs = extraMountErrors([row(), row({ folder: 'other', mount_path: '/var/www/html/media/' })]);
    expect(errs['1.mount_path']).toMatch(/Already mounted by row 1/);
    expect(errs['0.mount_path']).toBeUndefined();
  });
});

describe('<ExtraMountsEditor />', () => {
  it('adds a blank row', () => {
    const onChange = vi.fn();
    render(<ExtraMountsEditor rows={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('extra-mount-add'));
    expect(onChange).toHaveBeenCalledWith([{ folder: '', mount_path: '', read_only: false }]);
  });

  it('removes the right row', () => {
    const onChange = vi.fn();
    render(<ExtraMountsEditor rows={[row(), row({ folder: 'b', mount_path: '/srv/b' })]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('extra-mount-remove-0'));
    expect(onChange).toHaveBeenCalledWith([row({ folder: 'b', mount_path: '/srv/b' })]);
  });

  it('shows the validation message inline', () => {
    render(<ExtraMountsEditor rows={[row({ mount_path: '/usr' })]} onChange={vi.fn()} />);
    expect(screen.getByText(/image's own filesystem/)).toBeInTheDocument();
  });

  it('warns that a shared folder outlives the deployment', () => {
    render(<ExtraMountsEditor rows={[]} onChange={vi.fn()} />);
    expect(screen.getByTestId('extra-mounts-editor').textContent).toMatch(/not.*removed when this deployment is deleted/i);
  });
});
