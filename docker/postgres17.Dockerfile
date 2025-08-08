# PostgreSQL 17 + pg_cron for local development
FROM postgres:17

# Install pg_cron extension
RUN apt-get update && apt-get install -y \
    postgresql-17-cron \
    postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*

# Configure PostgreSQL to load pg_cron
RUN echo "shared_preload_libraries = 'pg_cron'" >> /usr/share/postgresql/postgresql.conf.sample
RUN echo "cron.database_name = 'rosetree_portfolio'" >> /usr/share/postgresql/postgresql.conf.sample

# Copy initialization scripts
COPY ./init-scripts/ /docker-entrypoint-initdb.d/

# Set environment
ENV POSTGRES_DB=rosetree_portfolio
ENV POSTGRES_USER=postgres
ENV POSTGRES_PASSWORD=local_dev_password

EXPOSE 5432