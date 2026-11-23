import { route } from '@/server/http';
import { handleUpdateVaultBundle } from '@/server/handlers/vaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = route(handleUpdateVaultBundle);
