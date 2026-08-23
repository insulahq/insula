import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HostnameLink } from '../components/HostnameLink';

describe('HostnameLink', () => {
  it('links a plain hostname to https://<host> in a new tab', () => {
    render(<HostnameLink host="blog.example.test" />);
    const link = screen.getByRole('link', { name: /blog\.example\.test/ });
    expect(link).toHaveAttribute('href', 'https://blog.example.test');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('appends a non-root path to both the href and the text', () => {
    render(<HostnameLink host="blog.example.test" path="/admin" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://blog.example.test/admin');
    expect(link).toHaveTextContent('blog.example.test/admin');
  });

  it('ignores a root path', () => {
    render(<HostnameLink host="example.test" path="/" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.test');
  });

  it('renders a wildcard as plain text, not a link (no valid URL to open)', () => {
    render(<HostnameLink host="*.sites.example.test" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('*.sites.example.test')).toBeInTheDocument();
  });
});
