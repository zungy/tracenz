/**
 * Site-wide settings. Everything a launch needs to fill in lives here.
 */

export const site = {
  name: 'Trace',
  description:
    'Trace logs every change you make in CAD and uses AI to turn that history into a design document.',

  /**
   * Download URLs for the desktop app. While a URL is null, the download
   * buttons explain that the download isn't available yet.
   */
  downloads: {
    windows: null as string | null,
    macos: null as string | null,
  },

  /**
   * Endpoints the login and signup forms POST to. While an endpoint is null,
   * the form validates input and then says sign-in isn't connected yet.
   */
  auth: {
    loginEndpoint: null as string | null,
    signupEndpoint: null as string | null,
  },

  /** Shown on the Enterprise plan. Replace with a real address. */
  salesEmail: 'sales@example.com',
};

export const nav = [
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Download', href: '/#download' },
];

/**
 * Each page is a "sheet" in the title-block footer, which also links them.
 * Login and signup share sheet 3.
 */
export const sheets = {
  home: { number: 1, title: 'Overview', href: '/' },
  pricing: { number: 2, title: 'Pricing', href: '/pricing' },
  account: { number: 3, title: 'Account', href: '/login' },
} as const;

export const sheetCount = 3;

export type SheetKey = keyof typeof sheets;
