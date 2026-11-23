import { route } from '@/server/http';
import { handleRunReplication } from '@/server/handlers/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handleRunReplication);
