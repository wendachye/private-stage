import { perform } from '../../../../workload.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() { try { return Response.json(await perform('GET', undefined)); } catch (error: any) { return Response.json({ error: error.message }, { status: error.status ?? 500 }); } }
export async function POST(request: Request) { try { return Response.json(await perform('POST', await request.json())); } catch (error: any) { return Response.json({ error: error.message }, { status: error.name === 'ZodError' ? 400 : error.status ?? 500 }); } }
