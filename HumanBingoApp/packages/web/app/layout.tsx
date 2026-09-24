import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import '@fontsource-variable/schibsted-grotesk';
import './globals.css';
import { eventFontVariables } from './fonts';

export const metadata: Metadata = {
  title: {
    default: 'Human Bingo | AKWE 2026',
    template: '%s | Human Bingo',
  },
  description: 'Meet the people behind the cloud at AKWE 2026.',
  applicationName: 'AKWE 2026 Human Bingo',
  appleWebApp: {
    capable: true,
    title: 'Human Bingo',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

const primaryLinks = [
  { href: '/join', label: 'Join a game' },
  { href: '/host', label: 'Host a game' },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={eventFontVariables}>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to the game
        </a>
        <header className="nav-slab">
          <Link className="nav-slab__brand" href="/" aria-label="AKWE 2026 Human Bingo home">
            <Image src="/brand/logos/akwe.webp" alt="" width={40} height={40} priority />
            <span>
              <strong>HUMAN BINGO</strong>
              <small>AKWE 2026 · CEBU</small>
            </span>
          </Link>
          <nav className="nav-slab__links" aria-label="Primary navigation">
            {primaryLinks.map((link) => (
              <Link href={link.href} key={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>
          <details className="nav-disclosure">
            <summary aria-label="Open navigation">Menu</summary>
            <nav className="nav-disclosure__panel" aria-label="Mobile navigation">
              {primaryLinks.map((link) => (
                <Link href={link.href} key={link.href}>
                  {link.label}
                </Link>
              ))}
            </nav>
          </details>
        </header>
        <main id="main-content">{children}</main>
        <footer className="foot-statement">
          <p className="foot-statement__line">Go find your people.</p>
          <div className="foot-statement__meta">
            <div className="foot-statement__marks" aria-label="Event partners">
              <Image src="/brand/logos/akwe.webp" alt="AKWE 2026" width={34} height={34} />
              <Image src="/brand/logos/upcsg.webp" alt="UPCSG" width={34} height={34} />
            </div>
            <span>AKWE 2026 · Human Bingo</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
