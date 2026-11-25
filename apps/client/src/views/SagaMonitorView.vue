<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { OrderStatusUpdatedWsPayload } from '@shop/contracts';
import {
  SagaCheckoutInitiatedPayload,
  socketManager,
} from '../services/socket';

type NodeState = 'idle' | 'processing' | 'success' | 'error' | 'compensated';
type SagaOverallState = 'IDLE' | 'PROCESSING' | 'PAID' | 'ROLLBACK';

interface TerminalLogEntry {
  id: string;
  time: string;
  source: string;
  message: string;
  level: 'info' | 'warn' | 'success' | 'error';
}

const overallState = ref<SagaOverallState>('IDLE');
const activeOrderId = ref<string | null>(null);
const activeTxId = ref<string | null>(null);

const nodeStates = ref<{
  gateway: NodeState;
  order: NodeState;
  rabbitmq: NodeState;
  catalog: NodeState;
  payment: NodeState;
}>({
  gateway: 'idle',
  order: 'idle',
  rabbitmq: 'idle',
  catalog: 'idle',
  payment: 'idle',
});

const logs = ref<TerminalLogEntry[]>([]);
const timers: Array<ReturnType<typeof setTimeout>> = [];

let unsubWs: (() => void) | null = null;
let unsubCheckout: (() => void) | null = null;

function formatTime(isoOrNow?: string): string {
  const date = isoOrNow ? new Date(isoOrNow) : new Date();
  return date.toTimeString().split(' ')[0];
}

function appendLog(
  source: string,
  message: string,
  level: TerminalLogEntry['level'] = 'info',
  timestamp?: string,
) {
  logs.value.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: formatTime(timestamp),
    source,
    message,
    level,
  });
}

function clearTimers() {
  while (timers.length > 0) {
    const t = timers.pop();
    if (t) clearTimeout(t);
  }
}

function resetMonitor() {
  clearTimers();
  overallState.value = 'IDLE';
  activeOrderId.value = null;
  activeTxId.value = null;
  nodeStates.value = {
    gateway: 'idle',
    order: 'idle',
    rabbitmq: 'idle',
    catalog: 'idle',
    payment: 'idle',
  };
  logs.value = [
    {
      id: 'init',
      time: formatTime(),
      source: 'System',
      message:
        'Live Saga Telemetry Monitor attached to Socket.IO & BroadcastChannel. Waiting for checkout...',
      level: 'info',
    },
  ];
}

function handleCheckoutInitiated(payload: SagaCheckoutInitiatedPayload) {
  clearTimers();
  overallState.value = 'PROCESSING';
  activeTxId.value = null;

  nodeStates.value = {
    gateway: 'processing',
    order: 'processing',
    rabbitmq: 'processing',
    catalog: 'idle',
    payment: 'idle',
  };

  appendLog(
    'API-Gateway',
    `POST /api/orders/checkout received (X-Idempotency-Key: ${payload.idempotencyKey.slice(0, 8)}..., Promo: ${payload.discountCode || 'NONE'})`,
    'warn',
    payload.timestamp,
  );
  appendLog(
    'Redis',
    `Locked idempotency key idempotency:*:${payload.idempotencyKey.slice(0, 8)} = PROCESSING`,
    'info',
    payload.timestamp,
  );
  appendLog(
    'OrderService',
    `Executing prisma.$transaction(): writing Order (PENDING) + Outbox event (order.created)`,
    'warn',
    payload.timestamp,
  );
}

function handleWsOrderEvent(payload: OrderStatusUpdatedWsPayload) {
  const shortOrder = payload.orderId.slice(0, 8);
  activeOrderId.value = payload.orderId;

  if (payload.status === 'PENDING') {
    overallState.value = 'PROCESSING';
    nodeStates.value.gateway = 'success';
    nodeStates.value.order = 'processing';
    nodeStates.value.rabbitmq = 'processing';
    nodeStates.value.catalog = 'processing';

    appendLog(
      'OutboxWorker',
      `Relayed unpublished Outbox row for Order #${shortOrder} -> RabbitMQ exchange "shop.events"`,
      'warn',
      payload.updatedAt,
    );
    appendLog(
      'RabbitMQ',
      `order.created delivered to catalog.order_created.queue`,
      'warn',
      payload.updatedAt,
    );
    appendLog(
      'CatalogService',
      `Reserving inventory in Serializable TX with Optimistic Lock (WHERE version = current.version)...`,
      'info',
      payload.updatedAt,
    );
    return;
  }

  if (payload.status === 'PAID') {
    clearTimers();
    overallState.value = 'PAID';
    activeTxId.value = payload.transactionId || 'tx_confirmed';

    nodeStates.value.gateway = 'success';
    nodeStates.value.order = 'success';
    nodeStates.value.rabbitmq = 'success';
    nodeStates.value.catalog = 'success';
    nodeStates.value.payment = 'processing';

    appendLog(
      'CatalogService',
      `Stock decremented (version + 1). Published catalog.stock.reserved to RabbitMQ`,
      'success',
    );
    appendLog(
      'RabbitMQ',
      `catalog.stock.reserved delivered to payment.stock_reserved.queue`,
      'info',
    );

    timers.push(
      setTimeout(() => {
        nodeStates.value.payment = 'success';
        appendLog(
          'PaymentService',
          `Payment authorized (${activeTxId.value}) for Order #${shortOrder}. Published payment.succeeded`,
          'success',
          payload.updatedAt,
        );
        appendLog(
          'OrderService',
          `Consumed payment.succeeded -> Order #${shortOrder} marked PAID. WebSocket push delivered!`,
          'success',
          payload.updatedAt,
        );
      }, 280),
    );
    return;
  }

  if (payload.status === 'FAILED' || payload.status === 'CANCELLED') {
    clearTimers();
    overallState.value = 'ROLLBACK';

    nodeStates.value.gateway = 'success';
    nodeStates.value.rabbitmq = 'error';
    nodeStates.value.catalog = 'success';
    nodeStates.value.payment = 'error';
    nodeStates.value.order = 'processing';

    appendLog(
      'CatalogService',
      `Stock reserved for Order #${shortOrder}. Published catalog.stock.reserved`,
      'info',
    );
    appendLog(
      'PaymentService',
      `FAIL_PAYMENT triggered! Charge declined for Order #${shortOrder}. Published payment.failed`,
      'error',
      payload.updatedAt,
    );

    timers.push(
      setTimeout(() => {
        nodeStates.value.catalog = 'compensated';
        appendLog(
          'CatalogService',
          `[COMPENSATING TX] Consumed payment.failed -> executed compensateStock(): stock = stock + qty, version = version + 1`,
          'error',
        );
      }, 320),
    );

    timers.push(
      setTimeout(() => {
        nodeStates.value.order = 'error';
        appendLog(
          'OrderService',
          `[SAGA ROLLBACK] Consumed payment.failed -> Order #${shortOrder} marked ${payload.status} & emitted order.cancelled`,
          'error',
        );
      }, 600),
    );
    return;
  }

  if (payload.status === 'REFUNDING') {
    clearTimers();
    overallState.value = 'PROCESSING';
    nodeStates.value.gateway = 'success';
    nodeStates.value.order = 'processing';
    nodeStates.value.rabbitmq = 'processing';
    nodeStates.value.payment = 'processing';
    nodeStates.value.catalog = 'idle';

    appendLog(
      'OrderService',
      `[REFUND SAGA] Order #${shortOrder} transitioned PAID -> REFUNDING + Outbox event order.refund_requested`,
      'warn',
      payload.updatedAt,
    );
    return;
  }

  if (payload.status === 'REFUNDED') {
    clearTimers();
    overallState.value = 'PAID';
    activeTxId.value = payload.transactionId || 'ref_confirmed';
    nodeStates.value.gateway = 'success';
    nodeStates.value.rabbitmq = 'success';
    nodeStates.value.payment = 'success';
    nodeStates.value.catalog = 'compensated';
    nodeStates.value.order = 'success';

    appendLog(
      'PaymentService',
      `[REFUND SAGA] Idempotent refund completed (${activeTxId.value}) for Order #${shortOrder}. Published payment.refunded`,
      'success',
      payload.updatedAt,
    );
    appendLog(
      'CatalogService',
      `[REFUND SAGA] Consumed payment.refunded -> restored stock & recorded StockMovement(REFUND_RESTORE)`,
      'success',
      payload.updatedAt,
    );
    appendLog(
      'OrderService',
      `[REFUND SAGA] Order #${shortOrder} marked REFUNDED. Refund receipt email & WebSocket push sent!`,
      'success',
      payload.updatedAt,
    );
  }
}

function runDemoSimulation(mode: 'PAID' | 'FAILED') {
  const fakeOrderId = `${Math.random().toString(16).slice(2, 10)}-demo-saga`;
  handleCheckoutInitiated({
    idempotencyKey: `${Math.random().toString(16).slice(2, 10)}-idemp`,
    discountCode: mode === 'FAILED' ? 'FAIL_PAYMENT' : 'WELCOME20',
    subtotal: 189,
    itemCount: 1,
    timestamp: new Date().toISOString(),
  });

  timers.push(
    setTimeout(() => {
      handleWsOrderEvent({
        orderId: fakeOrderId,
        userId: 'demo-user',
        status: 'PENDING' as any,
        message: `Order #${fakeOrderId.slice(0, 8)} created. Reserving stock...`,
        updatedAt: new Date().toISOString(),
      });
    }, 450),
  );

  timers.push(
    setTimeout(() => {
      handleWsOrderEvent({
        orderId: fakeOrderId,
        userId: 'demo-user',
        status: mode as any,
        transactionId: mode === 'PAID' ? 'tx_9f8a7b6c5d4e' : undefined,
        message:
          mode === 'PAID'
            ? `Order #${fakeOrderId.slice(0, 8)} paid!`
            : `Order #${fakeOrderId.slice(0, 8)} failed: Payment declined by mock gateway (FAIL_PAYMENT trigger)`,
        updatedAt: new Date().toISOString(),
      });
    }, 1150),
  );
}

function nodeCardClass(state: NodeState): string {
  switch (state) {
    case 'processing':
      return 'border-amber-400 bg-amber-500/15 text-amber-200 animate-pulse shadow-lg shadow-amber-500/20';
    case 'success':
      return 'border-emerald-500 bg-emerald-500/15 text-emerald-200 shadow-lg shadow-emerald-500/20';
    case 'error':
      return 'border-rose-500 bg-rose-500/15 text-rose-200 shadow-lg shadow-rose-500/25';
    case 'compensated':
      return 'border-rose-400 bg-rose-950/60 text-rose-200 ring-2 ring-rose-500/60 shadow-lg shadow-rose-500/25';
    default:
      return 'border-slate-800 bg-slate-900/80 text-slate-400';
  }
}

function statusPillText(state: NodeState): string {
  switch (state) {
    case 'processing':
      return 'PROCESSING';
    case 'success':
      return 'OK / COMMITTED';
    case 'error':
      return 'FAILED / ABORTED';
    case 'compensated':
      return 'ROLLBACK (+QTY)';
    default:
      return 'IDLE';
  }
}

const isRollbackActive = computed(() => overallState.value === 'ROLLBACK');

onMounted(() => {
  socketManager.ensureConnected();
  resetMonitor();
  unsubCheckout = socketManager.onCheckoutInitiated(handleCheckoutInitiated);
  unsubWs = socketManager.onOrderStatusUpdated(handleWsOrderEvent);
});

onUnmounted(() => {
  clearTimers();
  if (unsubCheckout) unsubCheckout();
  if (unsubWs) unsubWs();
});
</script>

<template>
  <div class="space-y-6">
    <!-- Top Header & Live Status Banner -->
    <section
      class="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/90 p-6 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <div class="flex items-center gap-2.5">
          <span
            class="h-2.5 w-2.5 rounded-full"
            :class="
              socketManager.connected.value
                ? 'bg-emerald-400 animate-ping'
                : 'bg-amber-400'
            "
          ></span>
          <span
            class="text-xs font-bold uppercase tracking-wider text-indigo-400"
          >
            Real-Time WebSocket &amp; Cross-Window Saga Monitor
          </span>
        </div>
        <h1 class="mt-1 text-2xl font-extrabold text-white">
          Live Choreography Saga &amp; Outbox Telemetry
        </h1>
        <p class="mt-1 text-xs text-slate-400">
          Keep this tab open alongside <code class="text-slate-200">/</code> and
          place an order (with <code class="text-emerald-400">WELCOME20</code> or
          <code class="text-rose-400">FAIL_PAYMENT</code>) to watch the distributed
          state machine react live.
        </p>
      </div>

      <!-- Quick Simulation & Reset Controls -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          @click="runDemoSimulation('PAID')"
          class="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition"
        >
          ▶ Simulate Happy Path
        </button>
        <button
          @click="runDemoSimulation('FAILED')"
          class="rounded-xl border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/25 transition"
        >
          ⚠ Simulate FAIL_PAYMENT Rollback
        </button>
        <button
          @click="resetMonitor"
          class="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
        >
          Reset
        </button>
      </div>
    </section>

    <!-- 5-Node Microservices Flowchart -->
    <section
      class="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 space-y-6"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4 text-xs">
          <span class="flex items-center gap-1.5 text-slate-400">
            <span class="h-2.5 w-2.5 rounded-full bg-slate-600"></span> Idle
          </span>
          <span class="flex items-center gap-1.5 text-amber-300">
            <span class="h-2.5 w-2.5 rounded-full bg-amber-400"></span>
            Processing (Outbox / RMQ)
          </span>
          <span class="flex items-center gap-1.5 text-emerald-300">
            <span class="h-2.5 w-2.5 rounded-full bg-emerald-400"></span> Happy
            Path (PAID)
          </span>
          <span class="flex items-center gap-1.5 text-rose-300">
            <span class="h-2.5 w-2.5 rounded-full bg-rose-500"></span>
            Compensating Rollback (FAILED)
          </span>
        </div>

        <div v-if="activeOrderId" class="text-xs font-mono text-slate-300">
          Active Order:
          <span class="font-bold text-indigo-400"
            >#{{ activeOrderId.slice(0, 8) }}</span
          >
          <span v-if="activeTxId" class="ml-2 text-emerald-400"
            >({{ activeTxId }})</span
          >
        </div>
      </div>

      <!-- Nodes Row: API Gateway -> Order Service -> RabbitMQ -> Catalog Service -> Payment Service -->
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-9 lg:items-center">
        <!-- Node 1: API Gateway -->
        <div
          class="rounded-2xl border-2 p-4 transition-all duration-300 lg:col-span-1"
          :class="nodeCardClass(nodeStates.gateway)"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider opacity-75"
              >Node 1</span
            >
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-black/30"
              >{{ statusPillText(nodeStates.gateway) }}</span
            >
          </div>
          <h3 class="mt-2 text-sm font-extrabold text-white">API Gateway</h3>
          <p class="mt-1 text-xs opacity-85">
            JwtGuard + Redis <code class="font-mono">X-Idempotency-Key</code>
          </p>
        </div>

        <!-- Arrow 1 -> 2 -->
        <div class="flex flex-col items-center justify-center text-center">
          <span class="text-[11px] font-mono text-slate-400">TCP RPC</span>
          <span
            class="text-xl font-bold transition-colors"
            :class="
              nodeStates.gateway !== 'idle'
                ? 'text-emerald-400'
                : 'text-slate-600'
            "
            >───▶</span
          >
          <span class="text-[10px] font-mono text-slate-500"
            >order.checkout</span
          >
        </div>

        <!-- Node 2: Order Service -->
        <div
          class="rounded-2xl border-2 p-4 transition-all duration-300 lg:col-span-1"
          :class="nodeCardClass(nodeStates.order)"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider opacity-75"
              >Node 2</span
            >
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-black/30"
              >{{ statusPillText(nodeStates.order) }}</span
            >
          </div>
          <h3 class="mt-2 text-sm font-extrabold text-white">Order Service</h3>
          <p class="mt-1 text-xs opacity-85">
            ACID TX: <code class="font-mono">Order</code> +
            <code class="font-mono">Outbox</code> in <code class="font-mono">order_db</code>
          </p>
        </div>

        <!-- Arrow 2 -> 3 -->
        <div class="flex flex-col items-center justify-center text-center">
          <span class="text-[11px] font-mono text-amber-400/90"
            >Outbox @1.5s</span
          >
          <span
            class="text-xl font-bold transition-colors"
            :class="
              nodeStates.rabbitmq !== 'idle'
                ? 'text-amber-400'
                : 'text-slate-600'
            "
            >───▶</span
          >
          <span class="text-[10px] font-mono text-slate-500"
            >order.created</span
          >
        </div>

        <!-- Node 3: RabbitMQ -->
        <div
          class="rounded-2xl border-2 p-4 transition-all duration-300 lg:col-span-1"
          :class="nodeCardClass(nodeStates.rabbitmq)"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider opacity-75"
              >Broker</span
            >
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-black/30"
              >{{ statusPillText(nodeStates.rabbitmq) }}</span
            >
          </div>
          <h3 class="mt-2 text-sm font-extrabold text-white">RabbitMQ</h3>
          <p class="mt-1 text-xs opacity-85">
            Exchange <code class="font-mono">shop.events</code> + DLQ
            <code class="font-mono">shop.dlq</code>
          </p>
        </div>

        <!-- Arrow 3 -> 4 -->
        <div class="flex flex-col items-center justify-center text-center">
          <span class="text-[11px] font-mono text-slate-400">AMQP Event</span>
          <span
            class="text-xl font-bold transition-colors"
            :class="
              nodeStates.catalog !== 'idle'
                ? 'text-emerald-400'
                : 'text-slate-600'
            "
            >───▶</span
          >
          <span class="text-[10px] font-mono text-slate-500">Reserve Stock</span>
        </div>

        <!-- Node 4: Catalog Service -->
        <div
          class="rounded-2xl border-2 p-4 transition-all duration-300 lg:col-span-1"
          :class="nodeCardClass(nodeStates.catalog)"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider opacity-75"
              >Node 4</span
            >
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-black/30"
              >{{ statusPillText(nodeStates.catalog) }}</span
            >
          </div>
          <h3 class="mt-2 text-sm font-extrabold text-white">
            Catalog Service
          </h3>
          <p class="mt-1 text-xs opacity-85">
            Serializable TX + <code class="font-mono">version</code> CAS Lock
          </p>
        </div>

        <!-- Arrow 4 -> 5 -->
        <div class="flex flex-col items-center justify-center text-center">
          <span class="text-[11px] font-mono text-slate-400"
            >stock.reserved</span
          >
          <span
            class="text-xl font-bold transition-colors"
            :class="
              nodeStates.payment === 'error'
                ? 'text-rose-500'
                : nodeStates.payment !== 'idle'
                  ? 'text-emerald-400'
                  : 'text-slate-600'
            "
            >───▶</span
          >
          <span class="text-[10px] font-mono text-slate-500">Charge Order</span>
        </div>

        <!-- Node 5: Payment Service -->
        <div
          class="rounded-2xl border-2 p-4 transition-all duration-300 lg:col-span-1"
          :class="nodeCardClass(nodeStates.payment)"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider opacity-75"
              >Node 5</span
            >
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-black/30"
              >{{ statusPillText(nodeStates.payment) }}</span
            >
          </div>
          <h3 class="mt-2 text-sm font-extrabold text-white">
            Payment Service
          </h3>
          <p class="mt-1 text-xs opacity-85">
            Idempotent by <code class="font-mono">orderId</code> in
            <code class="font-mono">payment_db</code>
          </p>
        </div>
      </div>

      <!-- Reverse Compensating Transaction Arrow (Lights up Red on FAILED) -->
      <div
        class="rounded-xl border-2 border-dashed p-4 transition-all duration-300"
        :class="
          isRollbackActive
            ? 'border-rose-500 bg-rose-950/30 text-rose-200 shadow-lg shadow-rose-500/15'
            : 'border-slate-800/80 bg-slate-950/40 text-slate-500'
        "
      >
        <div
          class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs font-mono"
        >
          <span class="font-bold uppercase tracking-wider">
            {{
              isRollbackActive
                ? '⚠ COMPENSATING SAGA ROLLBACK ACTIVE (payment.failed)'
                : 'Compensating Rollback Path (Standby)'
            }}
          </span>
          <span
            class="font-semibold"
            :class="isRollbackActive ? 'text-rose-300' : 'text-slate-500'"
          >
            [Payment Service] ───(payment.failed)───▶ [Catalog Service:
            compensateStock (+qty, version + 1)] ───▶ [Order Service: status =
            FAILED]
          </span>
        </div>
      </div>
    </section>

    <!-- Live Terminal Event Log -->
    <section
      class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl"
    >
      <div
        class="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-3"
      >
        <div class="flex items-center gap-2">
          <span class="h-3 w-3 rounded-full bg-rose-500/80"></span>
          <span class="h-3 w-3 rounded-full bg-amber-500/80"></span>
          <span class="h-3 w-3 rounded-full bg-emerald-500/80"></span>
          <span class="ml-2 text-xs font-mono font-semibold text-slate-300">
            saga-telemetry-stream — RabbitMQ (shop.events) &amp; Socket.IO
          </span>
        </div>
        <span class="text-xs font-mono text-slate-500"
          >{{ logs.length }} events</span
        >
      </div>

      <div class="max-h-80 overflow-y-auto p-5 font-mono text-xs space-y-2">
        <div
          v-for="entry in logs"
          :key="entry.id"
          class="flex items-start gap-3 leading-relaxed"
        >
          <span class="shrink-0 text-slate-500">[{{ entry.time }}]</span>
          <span
            class="shrink-0 w-32 font-bold"
            :class="{
              'text-indigo-400': entry.level === 'info',
              'text-amber-400': entry.level === 'warn',
              'text-emerald-400': entry.level === 'success',
              'text-rose-400': entry.level === 'error',
            }"
          >
            [{{ entry.source }}]
          </span>
          <span
            :class="{
              'text-slate-200': entry.level === 'info',
              'text-amber-200': entry.level === 'warn',
              'text-emerald-300 font-semibold': entry.level === 'success',
              'text-rose-300 font-semibold': entry.level === 'error',
            }"
          >
            {{ entry.message }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>
