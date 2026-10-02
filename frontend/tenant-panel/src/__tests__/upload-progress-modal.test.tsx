import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import UploadProgressModal from '@/components/files/UploadProgressModal';
import type { UploadProgress } from '@/hooks/use-file-manager';

// The upload modal must say how fast an upload is going while it runs, and
// what it came to once it lands — and must never put a speed on an upload
// that failed or was cancelled, where no number is true.

const MB = 1024 * 1024;

function upload(over: Partial<UploadProgress>): UploadProgress {
  return {
    filename: 'site.zip', loaded: 0, total: 0, percent: 0, status: 'uploading',
    startedAt: 0, speed: null, speedSamples: [], ...over,
  };
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByTitle(name).closest('[data-testid="upload-row"]');
  if (!(row instanceof HTMLElement)) throw new Error(`no upload row for ${name}`);
  return row;
}

afterEach(() => vi.useRealTimers());

describe('UploadProgressModal — a running upload', () => {
  it('shows bytes sent of total, percent, and the current speed', () => {
    render(<UploadProgressModal
      uploads={[upload({ loaded: 12 * MB, total: 48 * MB, percent: 25, speed: 2 * MB })]}
      onClose={vi.fn()}
    />);
    const row = rowFor('site.zip');
    expect(within(row).getByText('25%')).toBeInTheDocument();
    const line = within(row).getByTestId('upload-transfer');
    expect(line).toHaveTextContent('12.0 MB of 48.0 MB');
    expect(line).toHaveTextContent('2.0 MB/s');
  });

  it('shows no speed until one can be measured', () => {
    render(<UploadProgressModal
      uploads={[upload({ loaded: MB, total: 48 * MB, percent: 2, speed: null })]}
      onClose={vi.fn()}
    />);
    const line = within(rowFor('site.zip')).getByTestId('upload-transfer');
    expect(line).toHaveTextContent('1.0 MB of 48.0 MB');
    expect(line.textContent).not.toMatch(/\/s/);
  });

  it('says Finishing instead of a speed once every byte is sent and the server has not answered', () => {
    // Nothing is left to send, so the decaying live speed would read as a
    // stalled upload while the server writes the file.
    render(<UploadProgressModal
      uploads={[upload({ loaded: 48 * MB, total: 48 * MB, percent: 100, speed: 0 })]}
      onClose={vi.fn()}
    />);
    const line = within(rowFor('site.zip')).getByTestId('upload-transfer');
    expect(line).toHaveTextContent('48.0 MB of 48.0 MB');
    expect(line).toHaveTextContent('Finishing…');
    expect(line.textContent).not.toMatch(/\/s/);
  });
});

describe('UploadProgressModal — a completed upload', () => {
  it('shows the final size, the time it took and the average speed', () => {
    render(<UploadProgressModal
      uploads={[upload({
        status: 'done', loaded: 48 * MB, total: 48 * MB, percent: 100,
        startedAt: 1_000, finishedAt: 13_000,
      })]}
      onClose={vi.fn()}
    />);
    const row = rowFor('site.zip');
    expect(within(row).getByText('Done')).toBeInTheDocument();
    const line = within(row).getByTestId('upload-transfer');
    expect(line).toHaveTextContent('48.0 MB in 12 s');
    expect(line).toHaveTextContent('avg 4.0 MB/s');
  });

  it('stays on screen until the user closes it', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<UploadProgressModal
      uploads={[upload({ status: 'done', loaded: MB, total: MB, percent: 100, startedAt: 0, finishedAt: 500 })]}
      onClose={onClose}
    />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('upload-transfer')).toHaveTextContent('avg 2.0 MB/s');
  });

  it('shows the size of an empty file without inventing a speed', () => {
    render(<UploadProgressModal
      uploads={[upload({ status: 'done', loaded: 0, total: 0, percent: 100, startedAt: 0, finishedAt: 40 })]}
      onClose={vi.fn()}
    />);
    const line = screen.getByTestId('upload-transfer');
    expect(line).toHaveTextContent('0 B');
    expect(line.textContent).not.toMatch(/\/s/);
  });
});

describe('UploadProgressModal — failed and cancelled uploads', () => {
  it('shows the error and no size or speed for a failed upload', () => {
    render(<UploadProgressModal
      uploads={[upload({ status: 'error', loaded: 30 * MB, total: 48 * MB, error: 'Disk quota exceeded', speed: null })]}
      onClose={vi.fn()}
    />);
    const row = rowFor('site.zip');
    expect(within(row).getByText('Disk quota exceeded')).toBeInTheDocument();
    expect(within(row).queryByTestId('upload-transfer')).toBeNull();
    expect(row.textContent).not.toMatch(/\/s/);
  });

  it('shows Cancelled and no size or speed for a cancelled upload', () => {
    render(<UploadProgressModal
      uploads={[upload({ status: 'cancelled', loaded: 30 * MB, total: 48 * MB, error: 'Upload cancelled' })]}
      onClose={vi.fn()}
    />);
    const row = rowFor('site.zip');
    expect(within(row).getByText('Cancelled')).toBeInTheDocument();
    expect(within(row).queryByTestId('upload-transfer')).toBeNull();
    expect(row.textContent).not.toMatch(/\/s/);
  });
});

describe('UploadProgressModal — several files', () => {
  it('gives every file its own line and adds an overall line', () => {
    render(<UploadProgressModal
      uploads={[
        upload({ filename: 'a.bin', loaded: 10 * MB, total: 40 * MB, percent: 25, speed: MB }),
        upload({ filename: 'b.bin', loaded: 20 * MB, total: 40 * MB, percent: 50, speed: 3 * MB }),
        upload({ filename: 'c.bin', status: 'done', loaded: 20 * MB, total: 20 * MB, percent: 100, startedAt: 0, finishedAt: 5_000 }),
        upload({ filename: 'd.bin', status: 'cancelled', loaded: 5 * MB, total: 50 * MB }),
      ]}
      onClose={vi.fn()}
    />);
    expect(within(rowFor('a.bin')).getByTestId('upload-transfer')).toHaveTextContent('1.0 MB/s');
    expect(within(rowFor('b.bin')).getByTestId('upload-transfer')).toHaveTextContent('3.0 MB/s');
    expect(within(rowFor('c.bin')).getByTestId('upload-transfer')).toHaveTextContent('avg 4.0 MB/s');

    const overall = screen.getByTestId('upload-overall');
    expect(overall).toHaveTextContent('1 of 4 files done');
    // The cancelled file's 50 MB is no longer part of what is being sent.
    expect(overall).toHaveTextContent('50.0 MB of 100.0 MB');
    expect(overall).toHaveTextContent('4.0 MB/s');
    expect(within(overall).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('says Finishing on the overall line once every file has been sent', () => {
    render(<UploadProgressModal
      uploads={[
        upload({ filename: 'a.bin', loaded: 4 * MB, total: 4 * MB, percent: 100, speed: 0 }),
        upload({ filename: 'b.bin', status: 'done', loaded: MB, total: MB, percent: 100, startedAt: 0, finishedAt: 1_000 }),
      ]}
      onClose={vi.fn()}
    />);
    const overall = screen.getByTestId('upload-overall');
    expect(overall).toHaveTextContent('5.0 MB of 5.0 MB');
    expect(overall).toHaveTextContent('Finishing…');
    expect(overall.textContent).not.toMatch(/\/s/);
  });

  it('sums the finished batch over wall-clock time once everything has landed', () => {
    render(<UploadProgressModal
      uploads={[
        upload({ filename: 'a.bin', status: 'done', loaded: MB, total: MB, percent: 100, startedAt: 0, finishedAt: 2_000 }),
        upload({ filename: 'b.bin', status: 'done', loaded: 3 * MB, total: 3 * MB, percent: 100, startedAt: 0, finishedAt: 4_000 }),
        upload({ filename: 'c.bin', status: 'error', loaded: MB, total: 9 * MB, error: 'Network error' }),
      ]}
      onClose={vi.fn()}
    />);
    expect(screen.getByText('Upload Complete')).toBeInTheDocument();
    const overall = screen.getByTestId('upload-overall');
    expect(overall).toHaveTextContent('4.0 MB in 4.0 s');
    expect(overall).toHaveTextContent('avg 1.0 MB/s');
  });

  it('has no overall line for a single file — its own line already says it all', () => {
    render(<UploadProgressModal
      uploads={[upload({ loaded: MB, total: 4 * MB, percent: 25, speed: MB })]}
      onClose={vi.fn()}
    />);
    expect(screen.queryByTestId('upload-overall')).toBeNull();
  });
});
