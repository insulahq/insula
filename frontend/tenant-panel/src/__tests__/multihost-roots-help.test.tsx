import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultihostRootsHelpModal, ClearDocumentRootConfirm } from '@/components/MultihostRootsHelp';

describe('MultihostRootsHelpModal', () => {
  const base = {
    hostname: 'shop.example.test',
    appRoot: 'shop',
    siteFolder: 'shop/public',
    sitesRoot: '/var/www/sites',
    onClose: vi.fn(),
  };

  it('shows BOTH the File Manager path and the container path for each root', () => {
    render(<MultihostRootsHelpModal {...base} />);
    // The whole point of the modal: an operator uploading files needs the
    // volume-relative path, and an app's config file needs the absolute one.
    // Showing only one of the pair is what sent people to support.
    expect(screen.getByText('/shop')).toBeInTheDocument();
    expect(screen.getByText('/var/www/sites/shop')).toBeInTheDocument();
    expect(screen.getByText('/shop/public')).toBeInTheDocument();
    expect(screen.getByText('/var/www/sites/shop/public')).toBeInTheDocument();
  });

  it('labels the document root as shared when it equals the application root', () => {
    render(<MultihostRootsHelpModal {...base} siteFolder="shop" />);
    expect(screen.getByText(/same as application root/i)).toBeInTheDocument();
  });

  it('says "not set" rather than inventing a path when sitesRoot is unknown', () => {
    // sitesRoot comes from the catalog manifest and can legitimately be absent.
    // Rendering a half-built path like "null/shop" would be worse than nothing.
    render(<MultihostRootsHelpModal {...base} sitesRoot={null} />);
    expect(screen.getAllByText('not set').length).toBeGreaterThan(0);
    expect(screen.queryByText(/null\//)).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<MultihostRootsHelpModal {...base} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ClearDocumentRootConfirm', () => {
  const base = {
    hostname: 'shop.example.test',
    isPending: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('does not clear until confirmed', () => {
    const onConfirm = vi.fn();
    render(<ClearDocumentRootConfirm {...base} onConfirm={onConfirm} />);
    // Merely opening the dialog must not mutate anything.
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('clear-docroot-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirms on Enter', () => {
    const onConfirm = vi.fn();
    render(<ClearDocumentRootConfirm {...base} onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape without clearing', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ClearDocumentRootConfirm {...base} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('ignores Enter while a clear is already in flight', () => {
    // Holding Enter must not fire a second request against the same route.
    const onConfirm = vi.fn();
    render(<ClearDocumentRootConfirm {...base} isPending onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('states that no files are deleted', () => {
    // The X icon reads as destructive; the copy has to correct that or an
    // operator will avoid a harmless, reversible action.
    render(<ClearDocumentRootConfirm {...base} />);
    expect(screen.getByText(/No files are deleted/i)).toBeInTheDocument();
  });
});
