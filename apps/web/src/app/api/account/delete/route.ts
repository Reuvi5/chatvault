import { route } from '@/server/http';
import { handleDeleteAccount } from '@/server/handlers/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handleDeleteAccount);
