import { route } from '@/server/http';
import { handleBillingStatus } from '@/server/handlers/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(handleBillingStatus);
