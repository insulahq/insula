import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { UpdatesPill } from '../components/custom-deployments/UpdatesPill';
import type { UpdateCheckResult } from '@insula/api-contracts';

function res(partial: Partial<UpdateCheckResult>): UpdateCheckResult {
  return { status: 'no-update', current: null, latest: null, reason: null, checkedAt: '', ...partial };
}

describe('UpdatesPill', () => {
  it('renders a digest (moving-tag) update as an actionable "update available" that re-pulls', async () => {
    const onRepull = vi.fn();
    const onUpgrade = vi.fn();
    const user = userEvent.setup();
    render(
      <UpdatesPill
        result={res({ status: 'digest', current: 'latest', latest: 'sha256:abc…' })}
        loading={false}
        canManage
        onUpgrade={onUpgrade}
        onRepull={onRepull}
      />,
    );
    const btn = screen.getByText('update available');
    await user.click(btn);
    expect(onRepull).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it('routes a semver bump to onUpgrade, not onRepull', async () => {
    const onRepull = vi.fn();
    const onUpgrade = vi.fn();
    const user = userEvent.setup();
    render(
      <UpdatesPill
        result={res({ status: 'minor', current: '1.0.0', latest: '1.1.0' })}
        loading={false}
        canManage
        onUpgrade={onUpgrade}
        onRepull={onRepull}
      />,
    );
    await user.click(screen.getByText(/minor/));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onRepull).not.toHaveBeenCalled();
  });

  it('surfaces the failure reason on the unknown pill', () => {
    render(
      <UpdatesPill
        result={res({ status: 'unknown', reason: 'registry rate limited (429)' })}
        loading={false}
        canManage
        onUpgrade={vi.fn()}
        onRepull={vi.fn()}
      />,
    );
    expect(screen.getByTitle('registry rate limited (429)')).toBeInTheDocument();
  });

  it('does not act when the user cannot manage', async () => {
    const onRepull = vi.fn();
    const user = userEvent.setup();
    render(
      <UpdatesPill
        result={res({ status: 'digest', current: 'latest' })}
        loading={false}
        canManage={false}
        onUpgrade={vi.fn()}
        onRepull={onRepull}
      />,
    );
    await user.click(screen.getByText('update available'));
    expect(onRepull).not.toHaveBeenCalled();
  });
});
