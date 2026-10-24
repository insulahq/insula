import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BootstrapCommandResponse } from '@insula/api-contracts';
import { ApiError } from '../lib/api-client';

const fetchBootstrapCommand = vi.fn();

vi.mock('../hooks/use-cluster-network', () => ({
  fetchBootstrapCommand: (name: string, server?: string) =>
    server === undefined ? fetchBootstrapCommand(name) : fetchBootstrapCommand(name, server),
}));

import BootstrapCommandModal from '../components/security/BootstrapCommandModal';

const WORKER: BootstrapCommandResponse = {
  steps: [
    { id: 'download', title: 'Download the insula CLI 2026.10.2', runOn: 'new-node', command: 'curl … -o insula', note: null },
    {
      id: 'verify-install',
      title: 'Verify the signature, then install',
      runOn: 'new-node',
      command: 'if … openssl dgst …; then install …; fi',
      note: 'openssl must print "Verified OK".',
    },
    {
      id: 'join',
      title: 'Join the cluster as a worker',
      runOn: 'new-node',
      command: "insula bootstrap --join-as worker --server '198.51.100.10' --token 'K10aa::abcdef.0123456789abcdef' --dual-stack",
      note: null,
    },
  ],
  script: "(\nset -eu\ninsula bootstrap --join-as worker --server '198.51.100.10' --token 'K10aa::abcdef.0123456789abcdef' --dual-stack\n)",
  bootstrapCommand:
    "insula bootstrap --join-as worker --server '198.51.100.10' --token 'K10aa::abcdef.0123456789abcdef' --dual-stack",
  serverIp: '198.51.100.10',
  role: 'worker',
  nodeIp: '198.51.100.50',
  platformVersion: '2026.10.2',
  dualStack: true,
  joinToken: { kind: 'bootstrap', tokenId: 'abcdef', expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
  warning: null,
  notes: [],
};

const SERVER: BootstrapCommandResponse = {
  ...WORKER,
  role: 'server',
  steps: [
    {
      id: 'server-token',
      title: 'Read the server join token on an existing server (198.51.100.10)',
      runOn: 'existing-server',
      command: 'cat /var/lib/rancher/k3s/server/node-token',
      note: null,
    },
    ...WORKER.steps.slice(0, 2),
    {
      id: 'join',
      title: 'Join the cluster as a server',
      runOn: 'new-node',
      command: "read -rsp '…' INSULA_JOIN_TOKEN; echo\ninsula bootstrap --join-as server --server '198.51.100.10' --token \"$INSULA_JOIN_TOKEN\"",
      note: null,
    },
  ],
  joinToken: { kind: 'node-token', tokenId: null, expiresAt: null },
  warning: 'Joining a second server gives a 2-member etcd …',
  notes: ['This node was pre-enrolled by an IPv6 address …'],
};

beforeEach(() => {
  fetchBootstrapCommand.mockReset();
});

describe('BootstrapCommandModal', () => {
  it('worker: new-node heading, one copyable script, token expiry, no workstation/pre-auth', async () => {
    fetchBootstrapCommand.mockResolvedValue(WORKER);
    render(<BootstrapCommandModal cppName="w3" onClose={vi.fn()} />);

    expect(await screen.findByTestId('bootstrap-command-heading')).toHaveTextContent(
      'Run these on the new node 198.51.100.50 as root',
    );
    expect(fetchBootstrapCommand).toHaveBeenCalledWith('w3');
    expect(screen.getByTestId('bootstrap-script')).toHaveTextContent('--token');
    expect(screen.getByTestId('join-token-expiry')).toHaveTextContent('valid until');
    expect(screen.getByTestId('join-token-expiry')).toHaveTextContent(/in about 2 h/);
    expect(screen.getByText('Copy all')).toBeInTheDocument();
    expect(screen.getByText('Dual-stack (IPv4 + IPv6)')).toBeInTheDocument();
    expect(screen.queryByTestId('bootstrap-step-server-token')).toBeNull();
    expect(document.body.textContent).not.toMatch(/workstation|peer-firewall-add|pre-authorise/i);
  });

  it('server: existing-server step first, server-token explainer, etcd warning and notes stay', async () => {
    fetchBootstrapCommand.mockResolvedValue(SERVER);
    render(<BootstrapCommandModal cppName="s2" onClose={vi.fn()} />);

    expect(await screen.findByTestId('bootstrap-step-server-token')).toHaveTextContent(
      'cat /var/lib/rancher/k3s/server/node-token',
    );
    expect(screen.getByText(/Step 1 — on any existing server/)).toBeInTheDocument();
    expect(screen.getByText(/Steps 2–4 — on the new node/)).toBeInTheDocument();
    expect(screen.getByTestId('join-token-server')).toHaveTextContent('never shows that token');
    expect(screen.getByTestId('join-token-server')).toHaveTextContent('short-lived tokens can only join workers');
    expect(screen.queryByTestId('join-token-expiry')).toBeNull();
    expect(screen.getByTestId('bootstrap-command-warning')).toHaveTextContent('2-member etcd');
    expect(screen.getByTestId('bootstrap-command-notes')).toHaveTextContent('IPv6 address');
  });

  it('worker whose token could not be minted: says so instead of the server wording', async () => {
    fetchBootstrapCommand.mockResolvedValue({
      ...SERVER,
      role: 'worker',
      warning: null,
      notes: ['Could not mint a short-lived join token for this worker (GET /cacerts timed out) …'],
    });
    render(<BootstrapCommandModal cppName="w3" onClose={vi.fn()} />);
    expect(await screen.findByTestId('join-token-server')).toHaveTextContent('No short-lived token could be minted');
    expect(screen.getByTestId('bootstrap-command-notes')).toHaveTextContent('Could not mint');
  });

  it('renders a failure through ErrorPanel', async () => {
    fetchBootstrapCommand.mockRejectedValue(
      new ApiError(503, 'PLATFORM_VERSION_UNKNOWN', 'no version', {
        operatorError: {
          code: 'PLATFORM_VERSION_UNKNOWN',
          title: 'Cluster version unknown',
          detail: 'no version',
          remediation: ['Run insula version on an existing server.'],
          retryable: false,
        },
      }),
    );
    render(<BootstrapCommandModal cppName="w3" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('bootstrap-command-error')).toBeInTheDocument());
    expect(screen.getByText('Cluster version unknown')).toBeInTheDocument();
  });

  it('Escape closes the modal', async () => {
    fetchBootstrapCommand.mockResolvedValue(WORKER);
    const onClose = vi.fn();
    render(<BootstrapCommandModal cppName="w3" onClose={onClose} />);
    await screen.findByText('Copy all');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('one server: "Joins via" is a plain fact, no picker', async () => {
    fetchBootstrapCommand.mockResolvedValue({
      ...SERVER,
      servers: [{ name: 'sv1', ip: '198.51.100.10', ready: true, cordoned: false, answering: true }],
    });
    render(<BootstrapCommandModal cppName="s2" onClose={vi.fn()} />);
    await screen.findByTestId('bootstrap-step-server-token');
    expect(screen.queryByTestId('join-target-select')).toBeNull();
    expect(screen.getByText('198.51.100.10')).toBeInTheDocument();
  });

  it('several servers: pick another one and the steps are fetched for it', async () => {
    const servers = [
      { name: 'sv1', ip: '198.51.100.10', ready: true, cordoned: false, answering: false },
      { name: 'sv2', ip: '198.51.100.11', ready: true, cordoned: false, answering: true },
      { name: 'sv3', ip: '198.51.100.12', ready: false, cordoned: false, answering: null },
    ];
    fetchBootstrapCommand
      .mockResolvedValueOnce({ ...SERVER, serverIp: '198.51.100.11', servers })
      .mockResolvedValueOnce({
        ...SERVER,
        serverIp: '198.51.100.10',
        servers,
        bootstrapCommand: "insula bootstrap --join-as server --server '198.51.100.10'",
        notes: ['Server sv1 (198.51.100.10) did not answer on its API port just now — … Pick another server …'],
      });
    render(<BootstrapCommandModal cppName="s4" onClose={vi.fn()} />);
    const select = (await screen.findByTestId('join-target-select')) as HTMLSelectElement;
    expect(fetchBootstrapCommand).toHaveBeenLastCalledWith('s4');
    expect(select.value).toBe('198.51.100.11');
    const options = Array.from(select.options);
    expect(options.map((o) => o.textContent)).toEqual([
      'sv1 (198.51.100.10) — not answering',
      'sv2 (198.51.100.11)',
      'sv3 (198.51.100.12) — not Ready',
    ]);
    expect(options[2]?.disabled).toBe(true);

    fireEvent.change(select, { target: { value: '198.51.100.10' } });
    await waitFor(() => expect(fetchBootstrapCommand).toHaveBeenLastCalledWith('s4', '198.51.100.10'));
    await waitFor(() => expect((screen.getByTestId('join-target-select') as HTMLSelectElement).value).toBe('198.51.100.10'));
    expect(screen.getByTestId('bootstrap-command-notes')).toHaveTextContent('Pick another server');
  });

  it('a refused pick shows the error, and picking the same server again retries', async () => {
    const servers = [
      { name: 'sv1', ip: '198.51.100.10', ready: true, cordoned: false, answering: true },
      { name: 'sv2', ip: '198.51.100.11', ready: true, cordoned: false, answering: true },
    ];
    fetchBootstrapCommand
      .mockResolvedValueOnce({ ...SERVER, servers })
      .mockRejectedValueOnce(
        new ApiError(409, 'JOIN_TARGET_NOT_READY', 'Server sv2 (198.51.100.11) is not Ready — pick another server.'),
      )
      .mockResolvedValueOnce({ ...SERVER, serverIp: '198.51.100.11', servers });
    render(<BootstrapCommandModal cppName="s4" onClose={vi.fn()} />);
    const select = await screen.findByTestId('join-target-select');
    fireEvent.change(select, { target: { value: '198.51.100.11' } });
    await waitFor(() => expect(screen.getByTestId('bootstrap-command-error')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('join-target-select'), { target: { value: '198.51.100.11' } });
    await waitFor(() => expect(fetchBootstrapCommand).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByTestId('bootstrap-command-error')).toBeNull());
    expect((screen.getByTestId('join-target-select') as HTMLSelectElement).value).toBe('198.51.100.11');
  });

  it('copies the whole script', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fetchBootstrapCommand.mockResolvedValue(WORKER);
    render(<BootstrapCommandModal cppName="w3" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('Copy all'));
    expect(writeText).toHaveBeenCalledWith(WORKER.script);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
