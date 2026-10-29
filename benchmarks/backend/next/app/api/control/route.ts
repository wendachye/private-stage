import { control } from '../../../../workload.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { return Response.json(await control(await request.json())); }
  catch (error: any) { return Response.json({ error: error.message }, { status: 500 }); }
}
