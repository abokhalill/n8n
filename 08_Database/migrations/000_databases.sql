-- n8n owns the POSTGRES_DB created by the entrypoint. Application state gets its
-- own database so a wipe of one never touches the other.
CREATE DATABASE leadops;
