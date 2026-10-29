import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function NotFound() {
  return <main className="auth-screen error-screen"><Card className="error-card"><CardHeader><CardTitle><h1>Page not found</h1></CardTitle><CardDescription>This page is unavailable. Return to your community’s room.</CardDescription></CardHeader><CardContent><Button asChild><a href="/">Return to Stage</a></Button></CardContent></Card></main>;
}
