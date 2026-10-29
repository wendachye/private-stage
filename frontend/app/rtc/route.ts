import { upgradeWebSocket } from '@vercel/functions';
import { handleRtcUpgrade } from '../../server/rtc-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel closes function sockets at this deadline; the bridge requests reconnection first.
export const maxDuration = 300;

export async function GET(request: Request) {
  return handleRtcUpgrade(request, upgradeWebSocket);
}
