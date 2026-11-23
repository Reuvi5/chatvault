import { route } from '@/server/http';
import { handleCompleteObject } from '@/server/handlers/objects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handleCompleteObject);
