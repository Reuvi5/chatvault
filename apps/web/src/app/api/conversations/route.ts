import { route } from '@/server/http';
import { handleListConversations } from '@/server/handlers/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(handleListConversations);
