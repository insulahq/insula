/**
 * Header chip while an AI agent is connected — the user's own, or for a
 * tenant admin any agent of the account — so an agent acting in someone's name
 * is never invisible. Links to the list where it can be disconnected. Renders
 * nothing when none is connected (or tenant agents are off).
 */
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { useTenantAgents } from '@/hooks/use-ai-agents';

export default function AgentIndicator() {
  const { data } = useTenantAgents({ poll: true });
  const count = data?.connections.length ?? 0;
  if (count === 0) return null;
  const label = count === 1 ? '1 AI agent connected' : `${count} AI agents connected`;
  return (
    <Link
      to="/user-settings#ai-agents"
      title={`${label} — open to see or disconnect`}
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-200 dark:hover:bg-violet-900/50"
      data-testid="agent-indicator"
    >
      <Bot size={14} />
      <span className="hidden sm:inline">{count === 1 ? 'Agent connected' : `${count} agents`}</span>
      <span className="sm:hidden">{count}</span>
    </Link>
  );
}
