/**
 * Release notes are rendered as markdown, from a REAL published release body.
 *
 * The fixture below is the opening of v2026.9.26's GitHub release, pasted
 * verbatim — including the bit that makes hand-rolling this non-trivial:
 * bullets wrap across lines with two-space continuation, so a renderer that
 * treats each source line as a unit shreds every item mid-sentence.
 *
 * The other half of this file is the property the previous plaintext
 * rendering existed to protect: the body is remote content, and none of it
 * may become markup.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderChangelog, parseChangelogBlocks } from '@/lib/render-changelog';

const REAL_RELEASE_BODY = `### Added
- **Saved scheduled tasks can be edited.** Every row in Scheduled Tasks now has
  a pencil button that loads the task back into the form it was created in —
  name, schedule, URL or command, timeout and timezone.
- **A pinned timeout or timezone can be un-pinned.** Clearing either field on an
  edit puts the task back on the default.

### Fixed
- **Your plan's memory reading now matches what the cluster actually enforces.**
  Kubernetes charges a pod the *larger* of its containers and its init
  containers — for the pod's whole life.
`;

describe('changelog markdown rendering', () => {
  it('keeps a wrapped bullet as ONE list item', () => {
    const blocks = parseChangelogBlocks(REAL_RELEASE_BODY);
    const lists = blocks.filter((b) => b.kind === 'list') as Array<{ items: string[] }>;
    expect(lists).toHaveLength(2);
    expect(lists[0]!.items).toHaveLength(2);
    // The continuation lines are joined into the item, not split off.
    expect(lists[0]!.items[0]).toContain('pencil button');
    expect(lists[0]!.items[0]).toContain('timeout and timezone.');
  });

  it('renders headings, bullets and bold as elements', () => {
    render(<div>{renderChangelog(REAL_RELEASE_BODY)}</div>);
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    // Three bullets total across the two sections.
    expect(document.querySelectorAll('li')).toHaveLength(3);
    // The bold lead is a <strong>, not literal asterisks.
    expect(screen.getByText('Saved scheduled tasks can be edited.').tagName).toBe('STRONG');
    expect(document.body.textContent).not.toContain('**');
    expect(document.body.textContent).not.toContain('### ');
  });

  it('renders inline code and italics', () => {
    render(<div>{renderChangelog('Set `limit=100` and read the *larger* value.')}</div>);
    expect(screen.getByText('limit=100').tagName).toBe('CODE');
    expect(screen.getByText('larger').tagName).toBe('EM');
  });

  it('does not turn the release body into markup', () => {
    // The whole reason the modal used to print plaintext. A body containing
    // markup must render as TEXT — no element may be created from it.
    const hostile = 'Before <img src=x onerror=alert(1)> and <script>alert(2)</script> after.';
    const { container } = render(<div>{renderChangelog(hostile)}</div>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('refuses a link scheme that is not http(s), but keeps its text', () => {
    const { container } = render(
      <div>{renderChangelog('See [the notes](javascript:alert(1)) and [the release](https://example.test/r/1).')}</div>,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.test/r/1']);
    // Dropping the label would delete the sentence's subject.
    expect(container.textContent).toContain('the notes');
  });

  it('renders a fenced code block without interpreting its contents', () => {
    const { container } = render(
      <div>{renderChangelog('Run:\n```\nkubectl get rs\n**not bold**\n```\n')}</div>,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('kubectl get rs');
    expect(pre!.textContent).toContain('**not bold**');
  });

  it('passes unsupported constructs through as text rather than dropping them', () => {
    // Degrading to what the modal showed before is acceptable; losing a line
    // is not.
    const { container } = render(<div>{renderChangelog('| a | b |\n| - | - |\n| 1 | 2 |')}</div>);
    expect(container.textContent).toContain('| a | b |');
    expect(container.textContent).toContain('| 1 | 2 |');
  });
});
