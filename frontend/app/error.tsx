'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { RefreshCw, Shield } from 'lucide-react';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="auth-screen error-screen"><Card className="error-card"><CardHeader><Shield className="error-emblem" aria-hidden="true" /><CardTitle><h1>Something went wrong</h1></CardTitle><CardDescription>The page could not be displayed. Try again to reconnect.</CardDescription></CardHeader><CardContent className="error-actions"><Button onClick={reset}><RefreshCw size={16} />Try again</Button><Button variant="outline" onClick={() => window.location.reload()}>Reload page</Button></CardContent></Card></main>;
}
