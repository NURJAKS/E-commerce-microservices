*🇬🇧 [Read in English](README.md)*

# Микросервисная архитектура E-Commerce (паттерн Saga)

Событийно-ориентированная (Event-Driven) микросервисная платформа электронной коммерции, построенная на базе Nx, NestJS и Vue 3.
Проект демонстрирует ключевые паттерны распределённых систем: Choreography Saga, Transactional Outbox и Optimistic Locking.

## 🚀 Стек технологий

* **Backend:** NestJS (API Gateway + 5 микросервисов: Auth, Catalog, Order, Payment, Notification)
* **Frontend:** Vue 3 (Composition API, Pinia, TailwindCSS)
* **Инфраструктура:** PostgreSQL (изолированная БД на каждый сервис), Redis, RabbitMQ, Nginx, MinIO, Mailpit
* **DevOps:** Docker & Docker Compose

## 🛠️ Запуск проекта

1. Клонируйте репозиторий.
2. Скопируйте шаблон переменных окружения:
   ```bash
   cp .env.example .env
   ```
3. Запустите инфраструктуру и все микросервисы:
   ```bash
   docker compose up --build -d
   ```

## 📍 Навигация и эндпоинты

После запуска контейнеров будут доступны следующие интерфейсы:

- **Витрина магазина (Vue 3):** http://localhost (Администратор по умолчанию: `admin@shop.local` / `AdminPass123!`)
- **Live Saga Monitor (наблюдаемость в реальном времени):** http://localhost/architecture-monitor
- **Swagger-документация API:** http://localhost/api/docs (или http://localhost:3000/api/docs)
- **Панель RabbitMQ:** http://localhost:15672 (`guest` / `guest`)
- **Mailpit (перехват SMTP-писем):** http://localhost:8025
- **Консоль MinIO:** http://localhost:9001 (`minioadmin` / `minioadmin`)

## 💡 Ключевые архитектурные решения

1. **Choreography Saga:** Децентрализованная обработка заказов через Topic Exchange `shop.events` в RabbitMQ.
2. **Transactional Outbox:** Устранение проблемы двойной записи (Dual-Write) между PostgreSQL и RabbitMQ.
3. **Идемпотентность (Idempotency):** Защита на уровне API Gateway с помощью заголовка `X-Idempotency-Key` в Redis для предотвращения повторных списаний.
4. **Компенсирующие транзакции:** Автоматический откат состояния при сбое (например, возврат остатков товара в `catalog_db`, если оплата в `payment_db` завершилась ошибкой).
5. **RBAC и отзыв JWT (Blacklisting):** Zero-trust API Gateway с возможностью мгновенной блокировки скомпрометированных токенов через Redis.
