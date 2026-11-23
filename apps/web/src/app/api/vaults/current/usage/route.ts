import { route } from '@/server/http';
import { handleUsage } from '@/server/handlers/vaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(handleUsage);
