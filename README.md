*🇷🇺 [Читать описание на русском](README.ru.md)*

# Microservices E-Commerce Architecture (Saga Pattern)

An event-driven E-commerce microservices platform built with Nx, NestJS, and Vue 3.
Demonstrates distributed system patterns including Choreography Saga, Transactional Outbox, and Optimistic Locking.

## 🚀 Tech Stack

* **Backend:** NestJS (API Gateway + 5 Microservices: Auth, Catalog, Order, Payment, Notification)
* **Frontend:** Vue 3 (Composition API, Pinia, TailwindCSS)
* **Infrastructure:** PostgreSQL (Database-per-service), Redis, RabbitMQ, Nginx, MinIO, Mailpit
* **DevOps:** Docker & Docker Compose

## 🛠️ How to Run

1. Clone the repository.
2. Copy the environment variables:
   ```bash
   cp .env.example .env
   ```
3. Start the infrastructure and microservices:
   ```bash
   docker compose up --build -d
   ```

## 📍 Navigation & Endpoints

Once the containers are up, the following services are available:

- **Storefront (Vue 3):** http://localhost (Default Admin: `admin@shop.local` / `AdminPass123!`)
- **Live Saga Monitor (Observability):** http://localhost/architecture-monitor
- **API Swagger Docs:** http://localhost/api/docs (or http://localhost:3000/api/docs)
- **RabbitMQ Dashboard:** http://localhost:15672 (`guest` / `guest`)
- **Mailpit (SMTP Capture):** http://localhost:8025
- **MinIO Console:** http://localhost:9001 (`minioadmin` / `minioadmin`)

## 💡 Key Architectural Decisions

1. **Choreography Saga:** Decentralized order processing via RabbitMQ `shop.events` Topic Exchange.
2. **Transactional Outbox:** Preventing dual-write issues between PostgreSQL and RabbitMQ.
3. **Idempotency:** Gateway-level protection using `X-Idempotency-Key` via Redis to prevent double charges.
4. **Compensating Transactions:** Automated rollback logic (e.g., restoring stock in `catalog_db` if `payment_db` fails).
5. **RBAC & JWT Blacklisting:** Zero-trust Gateway with immediate token revocation capabilities via Redis.
