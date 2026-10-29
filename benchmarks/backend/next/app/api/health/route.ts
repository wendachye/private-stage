export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() { return Response.json({ ready: true, backend: 'Next.js production API' }); }
