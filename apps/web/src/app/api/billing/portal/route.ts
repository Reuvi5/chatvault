import { route } from '@/server/http';
import { handlePortal } from '@/server/handlers/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handlePortal);
