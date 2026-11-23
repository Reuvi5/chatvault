-- Creates the unprivileged application role used by docker compose.
--
-- This matters: row-level security does not apply to a superuser or to a role
-- with BYPASSRLS, so an application connecting as `postgres` would have every
-- policy silently ignored. The server checks its own role at startup and
-- refuses to run if it is privileged.

CREATE ROLE chatvault_app LOGIN PASSWORD 'app-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE chatvault TO chatvault_app;
GRANT USAGE ON SCHEMA public TO chatvault_app;
