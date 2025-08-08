# Makefile for rosetree-portfolio Docker development environment
.PHONY: help postgres timescale redis app test clean logs status

# Default help target
help:
	@echo "🌹 Rosetree Portfolio - Docker Development Environment"
	@echo ""
	@echo "Database Engines:"
	@echo "  make postgres    Start PostgreSQL 17 + pg_cron + Redis (default)"
	@echo "  make timescale   Start TimescaleDB + pg_cron + Redis"
	@echo ""  
	@echo "Application:"
	@echo "  make app         Start Next.js dev server (requires database)"
	@echo "  make full        Start PostgreSQL + Redis + Next.js"
	@echo ""
	@echo "Testing:"
	@echo "  make test        Run A/B performance tests"
	@echo "  make benchmark   Compare PostgreSQL vs TimescaleDB performance" 
	@echo ""
	@echo "Management:"
	@echo "  make logs        Show container logs"
	@echo "  make status      Show container status"
	@echo "  make clean       Stop and remove all containers"
	@echo "  make reset       Clean + remove volumes (⚠️  destroys data)"
	@echo ""
	@echo "Database Access:"
	@echo "  make psql        Connect to PostgreSQL"
	@echo "  make psql-ts     Connect to TimescaleDB" 
	@echo "  make redis-cli   Connect to Redis CLI"

# PostgreSQL 17 setup (default)
postgres:
	@echo "🐘 Starting PostgreSQL 17 + pg_cron + Redis..."
	docker-compose --profile postgres up -d postgres17 redis
	@echo "✅ PostgreSQL available at localhost:5432"
	@echo "✅ Redis available at localhost:6380"
	@echo ""
	@echo "Database: rosetree_portfolio"
	@echo "User: postgres"  
	@echo "Password: local_dev_password"
	@echo ""
	@echo "Connect: make psql"

# TimescaleDB setup
timescale:
	@echo "⏰ Starting TimescaleDB + pg_cron + Redis..."
	docker-compose --profile timescale up -d timescaledb redis
	@echo "✅ TimescaleDB available at localhost:5433"
	@echo "✅ Redis available at localhost:6380"
	@echo ""
	@echo "Database: rosetree_portfolio"
	@echo "User: postgres"
	@echo "Password: local_dev_password" 
	@echo ""
	@echo "Connect: make psql-ts"

# Redis only
redis:
	@echo "📦 Starting Redis..."
	docker-compose --profile default up -d redis

# Next.js app (requires database)
app:
	@echo "🚀 Starting Next.js development server..."
	docker-compose --profile app up -d app
	@echo "✅ App available at http://localhost:3000"

# Full stack with PostgreSQL
full:
	@echo "🌟 Starting full stack (PostgreSQL + Redis + Next.js)..."
	docker-compose --profile postgres --profile app up -d
	@echo "✅ PostgreSQL: localhost:5432"
	@echo "✅ Redis: localhost:6379"  
	@echo "✅ App: http://localhost:3000"

# Performance testing
test:
	@echo "🧪 Running performance tests..."
	docker-compose --profile test up --build performance-tester
	@echo "📊 Results saved to ./test-results/"

# A/B benchmark comparison  
benchmark:
	@echo "⚔️  Starting A/B benchmark: PostgreSQL vs TimescaleDB"
	@echo ""
	@echo "1️⃣  Starting PostgreSQL 17..."
	docker-compose --profile postgres up -d postgres17 redis
	@echo "⏳ Waiting for PostgreSQL to be ready..."
	@sleep 10
	@echo "🧪 Running PostgreSQL tests..."
	docker-compose --profile test run --rm performance-tester /tests/postgres-benchmark.sh
	@echo ""
	@echo "2️⃣  Starting TimescaleDB..."
	docker-compose --profile postgres down
	docker-compose --profile timescale up -d timescaledb redis  
	@echo "⏳ Waiting for TimescaleDB to be ready..."
	@sleep 10
	@echo "🧪 Running TimescaleDB tests..."
	docker-compose --profile test run --rm performance-tester /tests/timescale-benchmark.sh
	@echo ""
	@echo "📊 Benchmark complete! Check ./test-results/ for detailed comparison."

# Database connections
psql:
	@echo "🐘 Connecting to PostgreSQL..."
	docker-compose exec postgres17 psql -U postgres -d rosetree_portfolio

psql-ts:
	@echo "⏰ Connecting to TimescaleDB..."
	docker-compose exec timescaledb psql -U postgres -d rosetree_portfolio

redis-cli:
	@echo "📦 Connecting to Redis..."
	docker-compose exec redis redis-cli

# Container management
logs:
	docker-compose logs -f

status:
	@echo "📋 Container Status:"
	@docker-compose ps
	@echo ""
	@echo "💾 Volume Usage:"
	@docker volume ls | grep rosetree-portfolio

clean:
	@echo "🧹 Stopping and removing containers..."
	docker-compose --profile postgres --profile timescale --profile app --profile test down

reset: clean
	@echo "⚠️  Removing all volumes (this will destroy all data)..."
	@read -p "Are you sure? [y/N] " -n 1 -r; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		docker volume rm -f rosetree-portfolio-postgres17-data rosetree-portfolio-timescale-data rosetree-portfolio-redis-data 2>/dev/null || true; \
		echo ""; \
		echo "✅ All data volumes removed"; \
	else \
		echo ""; \
		echo "❌ Reset cancelled"; \
	fi

# Development helpers
migrate:
	@echo "🗄️  Running database migrations..."
	docker-compose exec app npm run db:migrate

seed:
	@echo "🌱 Seeding database with test data..."
	docker-compose exec app npm run db:seed

build:
	@echo "🔨 Building all Docker images..."
	docker-compose build

pull:
	@echo "⬇️  Pulling latest base images..."
	docker-compose pull