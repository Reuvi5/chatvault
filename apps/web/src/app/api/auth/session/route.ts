import { route } from '@/server/http';
import { handleSession } from '@/server/handlers/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(handleSession);
