import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
  title: 'Private Stage',
  description: 'A private space to share screens, pass the mic, and bring your Discord community together.',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className="dark"><body><TooltipProvider delayDuration={300}>{children}</TooltipProvider></body></html>;
}
