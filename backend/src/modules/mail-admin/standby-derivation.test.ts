/**
 * Which nodes pre-stage the mail store.
 *
 * Before 2026-09-11 this was a literal secondary+tertiary list, which after a
 * failover put a replicator on the ACTIVE node (rsyncing from its own pod)
 * and left the PRIMARY — the failback target — with no fresh data, forcing
 * every failback down the slow restic path. On staging the primary's standby
 * sentinel was two months old.
 */
import { describe, it, expect } from 'vitest';
import { deriveStandbyNodes } from './placement.js';

describe('deriveStandbyNodes', () => {
  it('stages on the primary so failback can use the FAST PATH', () => {
    // Stack has failed over to the secondary; the primary must now pre-stage.
    expect(deriveStandbyNodes({
      primary: 'node-a', secondary: 'node-b', tertiary: 'node-c', activeNode: 'node-b',
    })).toEqual(['node-a', 'node-c']);
  });

  it('never stages on the node the stack is running on', () => {
    const out = deriveStandbyNodes({
      primary: 'node-a', secondary: 'node-b', tertiary: null, activeNode: 'node-a',
    });
    expect(out).not.toContain('node-a');
    expect(out).toEqual(['node-b']);
  });

  it('de-duplicates when the same node is configured twice', () => {
    expect(deriveStandbyNodes({
      primary: 'node-a', secondary: 'node-a', tertiary: 'node-b', activeNode: 'node-c',
    })).toEqual(['node-a', 'node-b']);
  });

  it('returns nothing when only the active node is configured', () => {
    expect(deriveStandbyNodes({
      primary: 'node-a', secondary: null, tertiary: null, activeNode: 'node-a',
    })).toEqual([]);
  });

  it('handles an unknown active node — everything configured pre-stages', () => {
    expect(deriveStandbyNodes({
      primary: 'node-a', secondary: 'node-b', tertiary: null, activeNode: null,
    })).toEqual(['node-a', 'node-b']);
  });

  it('returns nothing when nothing is configured', () => {
    expect(deriveStandbyNodes({
      primary: null, secondary: null, tertiary: null, activeNode: 'node-a',
    })).toEqual([]);
  });
});
