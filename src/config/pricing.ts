/**
 * Plans, prices and the comparison table. Prices are placeholders in USD per
 * month; the yearly price is ten months' worth, billed once a year.
 */

export type PlanId = 'free' | 'pro' | 'team';

export interface Plan {
  id: PlanId;
  name: string;
  summary: string;
  monthly: number;
  yearly: number;
  unit: string;
  cta: { label: string; href: string };
  recommended?: boolean;
  includes: string[];
}

export const plans: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    summary: 'For trying Trace on a single project.',
    monthly: 0,
    yearly: 0,
    unit: 'per month',
    cta: { label: 'Sign up free', href: '/signup' },
    includes: [
      '1 active project',
      '30 days of change history',
      '3 design documents a month',
      'PDF export',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    summary: 'For engineers documenting their own designs.',
    monthly: 24,
    yearly: 20,
    unit: 'per month',
    cta: { label: 'Start with Pro', href: '/signup?plan=pro' },
    recommended: true,
    includes: [
      'Unlimited projects',
      'Full change history',
      'Unlimited design documents',
      'PDF, Word and Markdown export',
      'Custom document templates',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    summary: 'For teams that review designs together.',
    monthly: 48,
    yearly: 40,
    unit: 'per user, per month',
    cta: { label: 'Start with Team', href: '/signup?plan=team' },
    includes: [
      'Everything in Pro',
      'Shared projects and logs',
      'Comments and review on changes',
      'Roles and permissions',
      'Priority support',
    ],
  },
];

/** true = included, false = not included, string = included with this detail. */
export type Cell = boolean | string;

export interface FeatureGroup {
  name: string;
  rows: { feature: string; values: [Cell, Cell, Cell] }[];
}

export const comparison: FeatureGroup[] = [
  {
    name: 'Capture',
    rows: [
      { feature: 'Automatic CAD change logging', values: [true, true, true] },
      { feature: 'Active projects', values: ['1', 'Unlimited', 'Unlimited'] },
      { feature: 'Change history', values: ['30 days', 'Full', 'Full'] },
      { feature: 'Search and filters', values: [true, true, true] },
    ],
  },
  {
    name: 'Documents',
    rows: [
      { feature: 'Design documents per month', values: ['3', 'Unlimited', 'Unlimited'] },
      { feature: 'Links from document to log entries', values: [true, true, true] },
      { feature: 'Export', values: ['PDF', 'PDF, Word, Markdown', 'PDF, Word, Markdown'] },
      { feature: 'Custom templates', values: [false, true, true] },
    ],
  },
  {
    name: 'Collaboration',
    rows: [
      { feature: 'Shared projects', values: [false, false, true] },
      { feature: 'Comments and review', values: [false, false, true] },
      { feature: 'Roles and permissions', values: [false, false, true] },
    ],
  },
  {
    name: 'Support',
    rows: [{ feature: 'Support', values: ['Community', 'Email', 'Priority'] }],
  },
];

export const faqs = [
  {
    q: 'What does Trace record?',
    a: 'Trace records the changes you make to a model, such as features, sketch dimensions, parts, mates and materials. Each entry keeps the value before and after the change, the time, and the session it belongs to.',
  },
  {
    q: 'What goes into a design document?',
    a: 'An overview of the design, covering parts, assemblies, materials and key dimensions, followed by the changes since the last revision. Each statement links back to the log entries it came from.',
  },
  {
    q: 'Can I edit the document Trace writes?',
    a: 'Yes. Edit it in Trace, or export it and keep working in Word or Markdown. Generating a new revision keeps the earlier ones.',
  },
  {
    q: 'What happens when I reach the Free plan limits?',
    a: 'Trace keeps logging. To open a second project, see history older than 30 days or write more than three documents in a month, upgrade to Pro.',
  },
  {
    q: 'Can I change plans or cancel?',
    a: 'Yes. Upgrade, downgrade or cancel from your account settings at any time. A paid plan stays active until the end of its billing period.',
  },
];
