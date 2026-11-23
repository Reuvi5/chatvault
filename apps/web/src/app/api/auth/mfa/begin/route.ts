import { route } from '@/server/http';
import { handleMfaBegin } from '@/server/handlers/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handleMfaBegin);
