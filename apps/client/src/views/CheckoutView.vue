<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type {
  OrderDto,
  OrderStatusUpdatedWsPayload,
  PaymentDto,
} from '@shop/contracts';
import { http } from '../api/http';
import { socketManager } from '../services/socket';

const route = useRoute();
const order = ref<OrderDto | null>(null);
const payment = ref<PaymentDto | null>(null);
const loading = ref(true);
const wsEvents = ref<OrderStatusUpdatedWsPayload[]>([]);

let unsubscribeWs: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const orderId = computed(() => String(route.params.id));

async function fetchOrderState() {
  try {
    const { data } = await http.get<OrderDto>(`/orders/${orderId.value}`);
    order.value = data;
    if (data.status === 'PAID' || data.status === 'FAILED') {
      try {
        const payRes = await http.get<PaymentDto>(
          `/orders/${orderId.value}/payment`,
        );
        payment.value = payRes.data;
      } catch {
        // Ignore if payment record not yet available
      }
    }
    if (data.status !== 'PENDING' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await fetchOrderState();

  unsubscribeWs = socketManager.onOrderStatusUpdated(async (payload) => {
    if (payload.orderId === orderId.value) {
      wsEvents.value.unshift(payload);
      if (order.value) {
        order.value.status = payload.status;
      }
      await fetchOrderState();
    }
  });

  // Poll every 600ms while PENDING in case the fast Saga finished during route transition
  if (order.value?.status === 'PENDING') {
    pollTimer = setInterval(fetchOrderState, 600);
  }
});

onUnmounted(() => {
  if (unsubscribeWs) unsubscribeWs();
  if (pollTimer) clearInterval(pollTimer);
});

const statusLabel = computed(() => {
  if (!order.value) return '';
  switch (order.value.status) {
    case 'PAID':
      return 'Успешно оплачено (PAID)';
    case 'FAILED':
      return 'Ошибка оплаты — возврат склада (FAILED)';
    case 'CANCELLED':
      return 'Отменен (CANCELLED)';
    default:
      return 'Обработка Saga (PENDING)';
  }
});
</script>

<template>
  <div v-if="loading" class="py-16 text-center text-slate-400">
    Loading order &amp; Saga state...
  </div>

  <div v-else-if="order" class="max-w-3xl mx-auto space-y-6">
    <!-- Order Header Card -->
    <div
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 sm:p-8 space-y-6"
    >
      <div
        class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-6"
      >
        <div>
          <span class="text-xs font-semibold uppercase tracking-wider text-indigo-400">
            Choreography Saga Order
          </span>
          <h1 class="mt-1 text-2xl font-extrabold text-white">
            Order #{{ order.id.slice(0, 8) }}
          </h1>
          <p class="text-xs text-slate-400 mt-0.5">
            Created {{ new Date(order.createdAt).toLocaleString() }}
          </p>
        </div>

        <span
          data-testid="order-status-badge"
          class="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold border"
          :class="{
            'border-emerald-500/40 bg-emerald-500/15 text-emerald-300':
              order.status === 'PAID',
            'border-amber-500/40 bg-amber-500/15 text-amber-300 animate-pulse':
              order.status === 'PENDING',
            'border-rose-500/40 bg-rose-500/15 text-rose-300':
              order.status === 'FAILED' || order.status === 'CANCELLED',
          }"
        >
          {{ statusLabel }}
        </span>
      </div>

      <!-- Visual Choreography Saga Pipeline -->
      <div class="space-y-3">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400">
          RabbitMQ Topic Exchange (`shop.events`) Saga Flow
        </h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div
            class="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3.5"
          >
            <div class="text-xs font-bold text-emerald-400">
              1. order.created
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              Order saved (PENDING) &amp; Redis cart cleared
            </p>
          </div>

          <div
            class="rounded-xl border p-3.5"
            :class="
              order.status === 'CANCELLED'
                ? 'border-rose-500/30 bg-rose-950/20'
                : 'border-emerald-500/30 bg-emerald-950/20'
            "
          >
            <div
              class="text-xs font-bold"
              :class="
                order.status === 'CANCELLED'
                  ? 'text-rose-400'
                  : 'text-emerald-400'
              "
            >
              2. catalog.stock.*
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              {{
                order.status === 'CANCELLED'
                  ? 'Out of stock rejection'
                  : 'Atomic SQL stock reserved'
              }}
            </p>
          </div>

          <div
            class="rounded-xl border p-3.5"
            :class="{
              'border-emerald-500/30 bg-emerald-950/20':
                order.status === 'PAID',
              'border-rose-500/30 bg-rose-950/20': order.status === 'FAILED',
              'border-slate-800 bg-slate-950/40':
                order.status === 'PENDING' || order.status === 'CANCELLED',
            }"
          >
            <div
              class="text-xs font-bold"
              :class="{
                'text-emerald-400': order.status === 'PAID',
                'text-rose-400': order.status === 'FAILED',
                'text-slate-400':
                  order.status === 'PENDING' || order.status === 'CANCELLED',
              }"
            >
              3. payment.*
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              {{
                order.status === 'PAID'
                  ? `Tx: ${payment?.transactionId || 'Confirmed'}`
                  : order.status === 'FAILED'
                    ? 'Declined -> Stock Compensated'
                    : 'Awaiting gateway'
              }}
            </p>
          </div>

          <div
            class="rounded-xl border p-3.5"
            :class="{
              'border-emerald-500/30 bg-emerald-950/20':
                order.status === 'PAID',
              'border-rose-500/30 bg-rose-950/20':
                order.status === 'FAILED' || order.status === 'CANCELLED',
              'border-slate-800 bg-slate-950/40': order.status === 'PENDING',
            }"
          >
            <div
              class="text-xs font-bold"
              :class="{
                'text-emerald-400': order.status === 'PAID',
                'text-rose-400':
                  order.status === 'FAILED' || order.status === 'CANCELLED',
                'text-slate-400': order.status === 'PENDING',
              }"
            >
              4. Notification
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              Mailpit SMTP email + WebSocket push
            </p>
          </div>
        </div>
      </div>

      <!-- Order Line Items -->
      <div class="space-y-3 border-t border-slate-800 pt-6">
        <h3 class="text-sm font-bold text-white">Order Items</h3>
        <div
          v-for="item in order.items"
          :key="item.id"
          class="flex items-center justify-between rounded-xl border border-slate-800/80 bg-slate-950/50 px-4 py-3 text-sm"
        >
          <div>
            <span class="font-semibold text-white">{{
              item.productTitle
            }}</span>
            <span class="ml-2 text-xs text-slate-400"
              >× {{ item.quantity }}</span
            >
          </div>
          <span class="font-bold text-slate-200">
            ${{ (Number(item.unitPrice) * item.quantity).toFixed(2) }}
          </span>
        </div>

        <div class="flex items-center justify-between pt-3 text-base font-bold text-white">
          <div>
            <span>Total Paid</span>
            <span
              v-if="order.discountCode"
              class="ml-2 rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
            >
              Promo: {{ order.discountCode }}
            </span>
          </div>
          <span class="text-xl text-indigo-400" data-testid="order-total-amount">
            ${{ Number(order.totalAmount).toFixed(2) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
