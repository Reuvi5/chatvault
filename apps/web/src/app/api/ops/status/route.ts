import { route } from '@/server/http';
import { handleOpsStatus } from '@/server/handlers/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(handleOpsStatus);
